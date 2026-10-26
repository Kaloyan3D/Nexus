//! `nexus-egress`: the network egress service of one execution (see `nexus_tools::egress`).
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.get(1).map(String::as_str) == Some("--version") {
        println!("{}", nexus_tools::egress::PROTOCOL);
        return;
    }
    let dir = a
        .iter()
        .position(|x| x == "--dir")
        .and_then(|i| a.get(i + 1))
        .cloned()
        .unwrap_or_default();
    if dir.is_empty() {
        eprintln!("nexus-egress: --dir <directory> is required");
        std::process::exit(2);
    }
    if let Err(e) = nexus_tools::egress::serve(std::path::Path::new(&dir)) {
        eprintln!("nexus-egress: {e}");
        std::process::exit(1);
    }
}
