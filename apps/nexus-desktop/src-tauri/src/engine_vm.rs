//! The embedded Linux engine: a headless microVM run by the bundled `nexus-vm` helper
//! (Virtualization.framework). This module makes sure the guest image is in place and gives the
//! bridge a transport that talks to it over virtio-vsock. No network port, no SSH, no manual setup.
//!
//! Layout in the app data directory (`<data>/engine/`):
//! `Image` (arm64 kernel), `root.img` (pristine system disk; every boot runs a copy-on-write clone),
//! `state.img` (persistent engine data: its home, staged projects, credentials), `vm.json`, `version`.

use crate::bridge_link::Transport;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[derive(Debug, Deserialize)]
struct Manifest {
    /// Identifies the image build; a different value re-provisions the system disk.
    version: String,
}

pub struct VmTransport {
    pub helper: PathBuf,
    /// `Resources/engine` of the app bundle (compressed image), when running as an app.
    pub bundled: Option<PathBuf>,
    /// An unpacked image directory (`Image`, `rootfs.img`) for development.
    pub dev_image: Option<PathBuf>,
    pub dir: PathBuf,
    provisioned: Mutex<bool>,
}

fn io(m: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(m.to_string())
}

impl VmTransport {
    pub fn new(
        helper: PathBuf,
        bundled: Option<PathBuf>,
        dev_image: Option<PathBuf>,
        data: &Path,
    ) -> Self {
        Self {
            helper,
            bundled,
            dev_image,
            dir: data.join("engine"),
            provisioned: Mutex::new(false),
        }
    }

    /// Where the helper binary is: next to the app executable (`Contents/MacOS/nexus-vm`), or named by `NEXUS_VM_HELPER`.
    pub fn locate_helper() -> Option<PathBuf> {
        if let Some(p) = std::env::var_os("NEXUS_VM_HELPER") {
            return Some(PathBuf::from(p));
        }
        let p = std::env::current_exe().ok()?.parent()?.join("nexus-vm");
        p.is_file().then_some(p)
    }

    /// Whether there is an image to run at all (bundled or development).
    pub fn has_image(&self) -> bool {
        self.dir.join("version").is_file()
            || self
                .bundled
                .as_ref()
                .is_some_and(|b| b.join("manifest.json").is_file())
            || self
                .dev_image
                .as_ref()
                .is_some_and(|d| d.join("rootfs.img").is_file())
    }

    fn version_of_source(&self) -> Result<String, std::io::Error> {
        if let Some(d) = &self.dev_image {
            let md = std::fs::metadata(d.join("rootfs.img")).map_err(io)?;
            let t = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            return Ok(format!("dev-{}-{t}", md.len()));
        }
        let b = self
            .bundled
            .as_ref()
            .ok_or_else(|| io("this Nexus build has no engine image"))?;
        let m: Manifest =
            serde_json::from_slice(&std::fs::read(b.join("manifest.json")).map_err(io)?)
                .map_err(io)?;
        Ok(m.version)
    }

    /// Put the image in place (first run, or after an update). Idempotent and safe to repeat.
    pub fn provision(&self) -> Result<(), std::io::Error> {
        let mut done = self.provisioned.lock().map_err(|_| io("poisoned"))?;
        if *done {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))?;
        let want = self.version_of_source();
        let have = std::fs::read_to_string(self.dir.join("version")).ok();
        if let Ok(want) = want {
            if have.as_deref().map(str::trim) != Some(want.as_str()) {
                self.install_image()?;
                std::fs::write(self.dir.join("version"), &want)?;
            }
        } else if have.is_none() {
            return Err(want.unwrap_err());
        }
        // persistent state disk: sparse, created once; the guest formats it on first use
        let state = self.dir.join("state.img");
        if !state.exists() {
            let f = std::fs::File::create(&state)?;
            f.set_len(16 * 1024 * 1024 * 1024)?;
        }
        let cfg = serde_json::json!({
            "kernel": self.dir.join("Image"),
            "rootfs": self.dir.join("root.img"),
            "rootfsRun": self.dir.join("root.run.img"),
            "stateDisk": state,
            "cpus": std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2),
            "memoryMB": 2048,
            "vsockPort": 1024,
            "cmdline": "console=hvc0 root=/dev/vda rw rootfstype=ext4 selinux=0 audit=0 quiet",
            "idleSeconds": 120
        });
        std::fs::write(
            self.dir.join("vm.json"),
            serde_json::to_vec_pretty(&cfg).map_err(io)?,
        )?;
        *done = true;
        Ok(())
    }

    fn install_image(&self) -> Result<(), std::io::Error> {
        let tmp_root = self.dir.join("root.img.new");
        let tmp_kernel = self.dir.join("Image.new");
        let _ = std::fs::remove_file(&tmp_root);
        let _ = std::fs::remove_file(&tmp_kernel);
        if let Some(d) = &self.dev_image {
            clone_or_copy(&d.join("rootfs.img"), &tmp_root)?;
            clone_or_copy(&d.join("Image"), &tmp_kernel)?;
        } else {
            let b = self
                .bundled
                .as_ref()
                .ok_or_else(|| io("no engine image in this build"))?;
            let input = std::fs::File::open(b.join("rootfs.img.zst"))?;
            write_sparse(zstd::stream::Decoder::new(input)?, &tmp_root)?;
            clone_or_copy(&b.join("Image"), &tmp_kernel)?;
        }
        // replace atomically; a boot in progress keeps using its own clone
        std::fs::rename(&tmp_kernel, self.dir.join("Image"))?;
        std::fs::rename(&tmp_root, self.dir.join("root.img"))?;
        Ok(())
    }

    /// Ask a running VM to shut down (the app is quitting).
    pub fn stop(&self) {
        let _ = Command::new(&self.helper)
            .args(["stop", "--state-dir"])
            .arg(&self.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Write `from` to `to`, leaving runs of zeros as holes (the system disk is mostly empty space).
fn write_sparse(mut from: impl std::io::Read, to: &Path) -> std::io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut out = std::fs::File::create(to)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut pos = 0u64;
    loop {
        let mut n = 0;
        while n < buf.len() {
            let k = from.read(&mut buf[n..])?;
            if k == 0 {
                break;
            }
            n += k;
        }
        if n == 0 {
            break;
        }
        if buf[..n].iter().all(|b| *b == 0) {
            out.seek(SeekFrom::Current(n as i64))?;
        } else {
            out.write_all(&buf[..n])?;
        }
        pos += n as u64;
        if n < buf.len() {
            break;
        }
    }
    out.set_len(pos)?;
    out.sync_all()
}

fn clone_or_copy(from: &Path, to: &Path) -> std::io::Result<()> {
    // APFS clone when possible (instant, no extra space), plain copy otherwise
    let ok = Command::new("/bin/cp")
        .arg("-c")
        .arg(from)
        .arg(to)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if ok {
        return Ok(());
    }
    std::fs::copy(from, to).map(|_| ())
}

impl Transport for VmTransport {
    fn spawn(&self) -> std::io::Result<Child> {
        self.provision()?;
        Command::new(&self.helper)
            .args(["attach", "--state-dir"])
            .arg(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }

    fn describe(&self) -> String {
        "embedded Linux engine (virtio-vsock)".to_owned()
    }
}

impl Transport for std::sync::Arc<VmTransport> {
    fn spawn(&self) -> std::io::Result<Child> {
        (**self).spawn()
    }
    fn describe(&self) -> String {
        (**self).describe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provisioning_installs_the_image_once_and_writes_the_vm_config() {
        let t = tempfile::tempdir().unwrap();
        let img = t.path().join("img");
        std::fs::create_dir_all(&img).unwrap();
        std::fs::write(img.join("Image"), b"kernel").unwrap();
        std::fs::write(img.join("rootfs.img"), vec![7u8; 4096]).unwrap();
        let vm = VmTransport::new(
            PathBuf::from("/nonexistent/nexus-vm"),
            None,
            Some(img.clone()),
            &t.path().join("data"),
        );
        assert!(vm.has_image());
        vm.provision().unwrap();
        let e = t.path().join("data/engine");
        assert_eq!(std::fs::read(e.join("Image")).unwrap(), b"kernel");
        assert_eq!(
            std::fs::metadata(e.join("state.img")).unwrap().len(),
            16 * 1024 * 1024 * 1024
        );
        let cfg: serde_json::Value =
            serde_json::from_slice(&std::fs::read(e.join("vm.json")).unwrap()).unwrap();
        assert_eq!(cfg["vsockPort"], 1024);
        assert!(cfg["rootfsRun"].as_str().unwrap().ends_with("root.run.img"));
        // an unchanged image is not reinstalled; a changed one is
        let m1 = std::fs::metadata(e.join("root.img"))
            .unwrap()
            .modified()
            .unwrap();
        VmTransport::new(
            PathBuf::new(),
            None,
            Some(img.clone()),
            &t.path().join("data"),
        )
        .provision()
        .unwrap();
        assert_eq!(
            std::fs::metadata(e.join("root.img"))
                .unwrap()
                .modified()
                .unwrap(),
            m1
        );
        std::fs::write(img.join("rootfs.img"), vec![8u8; 8192]).unwrap();
        VmTransport::new(PathBuf::new(), None, Some(img), &t.path().join("data"))
            .provision()
            .unwrap();
        assert_eq!(std::fs::metadata(e.join("root.img")).unwrap().len(), 8192);
    }

    #[test]
    fn no_image_means_no_engine() {
        let t = tempfile::tempdir().unwrap();
        let vm = VmTransport::new(PathBuf::new(), None, None, t.path());
        assert!(!vm.has_image());
        assert!(vm.provision().is_err());
    }

    #[test]
    fn sparse_writer_keeps_holes_and_content() {
        let t = tempfile::tempdir().unwrap();
        let mut data = vec![0u8; 3 << 20];
        data[(2 << 20) + 5] = 9;
        let p = t.path().join("o");
        write_sparse(&data[..], &p).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), data);
    }
}
