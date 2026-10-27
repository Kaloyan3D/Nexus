//! M7C: development-server exposure — host loopback → a unix socket in the bound
//! `/nexus-dev` directory → the launch gate's in-sandbox bridge → the server's loopback
//! port inside its isolated network namespace.
//!
//! This is the reverse direction of M5's local-port forwards (which let the sandbox reach
//! host services). The host side never enters a namespace: it connects to the gate's unix
//! socket like any Nexus-owned service socket. Nothing is bound on a non-loopback address,
//! the host listener closes when the bridge drops, and the caller (JobManager) only starts
//! a bridge for a sandbox port the project's grant lists in `devPorts`.

use crate::result::{ToolError, ToolErrorCode};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn refuse(msg: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::SandboxUnavailable, msg)
}

pub struct DevBridge {
    pub job_port: u16,
    pub host_port: u16,
    stop: Arc<AtomicBool>,
}

impl DevBridge {
    /// Listen on host loopback (`requested_host_port`, 0 = ephemeral) and relay each
    /// connection through `<socket_dir>/dev-<job_port>.sock` to the job's server.
    pub fn start(
        socket_dir: PathBuf,
        job_port: u16,
        requested_host_port: u16,
    ) -> Result<Self, ToolError> {
        let listener = TcpListener::bind(("127.0.0.1", requested_host_port)).map_err(|e| {
            refuse(format!(
                "dev bridge bind 127.0.0.1:{requested_host_port}: {e}"
            ))
        })?;
        let host_port = listener
            .local_addr()
            .map_err(|e| refuse(format!("dev bridge addr: {e}")))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|e| refuse(format!("dev bridge nonblocking: {e}")))?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_loop = stop.clone();
        std::thread::spawn(move || {
            while !stop_loop.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let sock = socket_dir.join(format!("dev-{job_port}.sock"));
                        std::thread::spawn(move || relay(stream, sock));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            job_port,
            host_port,
            stop,
        })
    }
}

impl Drop for DevBridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // wake the accept loop so the listener closes promptly
        let _ = TcpStream::connect(("127.0.0.1", self.host_port));
    }
}

fn relay(mut host_side: TcpStream, sock: PathBuf) {
    let Ok(mut job_side) = std::os::unix::net::UnixStream::connect(&sock) else {
        return; // gate bridge not there (job ended): the connection fails closed
    };
    let _ = host_side.set_nonblocking(false);
    let mut a = match host_side.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut b = match job_side.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let up = std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match a.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = b.shutdown(std::net::Shutdown::Write);
                    break;
                }
                Ok(n) => {
                    if b.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut buf = [0u8; 16 * 1024];
    loop {
        match job_side.read(&mut buf) {
            Ok(0) | Err(_) => {
                let _ = host_side.shutdown(std::net::Shutdown::Write);
                break;
            }
            Ok(n) => {
                if host_side.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = up.join();
}
