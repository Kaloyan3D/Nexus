//! `nexus-bridge`: the Linux end of the macOS engine bridge. Built only with the `engine-bridge`
//! feature. `--stdio` is the SSH-era transport; `--vsock PORT` is the embedded engine's service.

#[cfg(all(target_os = "linux", feature = "engine-bridge"))]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("--stdio") => nexus_desktop_lib::run_bridge(),
        Some("--vsock") => match args.get(2).and_then(|p| p.parse::<u32>().ok()) {
            Some(port) => nexus_desktop_lib::run_bridge_vsock(port),
            None => {
                eprintln!("usage: nexus-bridge --vsock PORT");
                64
            }
        },
        _ => {
            eprintln!("usage: nexus-bridge --stdio | --vsock PORT");
            64
        }
    };
    std::process::exit(code);
}

#[cfg(not(all(target_os = "linux", feature = "engine-bridge")))]
fn main() {
    eprintln!("nexus-bridge is only built for Linux with the `engine-bridge` feature");
    std::process::exit(1);
}
