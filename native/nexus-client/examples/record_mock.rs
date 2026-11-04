//! Records one mock conversation into the native transcript store (used to
//! verify restart replay in the real window). Usage: record_mock <prompt>
use nexus_client::{run_mock_recorded, ClientConfig};

fn main() {
    let prompt = std::env::args().nth(1).unwrap_or_else(|| "mock".into());
    let cfg = ClientConfig::resolve(None, None, false).expect("config");
    let (_, id) = run_mock_recorded(&cfg, &prompt, &mut |_| {}).expect("mock run");
    println!("{id}");
}
