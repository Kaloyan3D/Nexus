#![allow(dead_code)]
//! `nexus-confine`: the in-sandbox launch gate (M3C). Runs as the FIRST process inside the bubblewrap
//! namespace: verifies the intended mount specification, closes inherited descriptors, applies Landlock and
//! only then executes the command. It never runs outside a sandbox for any purpose.
#[path = "../confine.rs"]
mod confine;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    confine::shim_main(args)
}
