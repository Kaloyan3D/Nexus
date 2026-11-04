//! Nexus desktop Tauri shell.
//!
//! One frontend, one command contract (`build.rs` + `capabilities/main.json`), two hosts:
//!
//! * **Linux** (`linux_app`): the engine (`nexusd`, `nexus-broker`, sandbox) runs on this
//!   machine and the shell talks to it through `nexus-client` / `nexus-runtime`.
//! * **macOS** (`macos_app`): a desktop-only host. The engine is Linux software and is not
//!   linked, started or simulated here; every engine command answers with a structured
//!   `engine-unavailable` error until a managed Linux engine is connected through the
//!   [`engine`] seam.
//!
//! Code shared by both (DTOs, the dialog contract, the engine seam) is compiled everywhere.

pub mod bridge_link;
pub mod bridge_proto;
pub mod dialogs;
pub mod dto;
pub mod engine;
pub mod engine_config;
#[cfg(target_os = "macos")]
pub mod engine_vm;
pub mod sync;

#[cfg(not(target_os = "macos"))]
mod backend;
#[cfg(not(target_os = "macos"))]
pub mod interactive;
#[cfg(not(target_os = "macos"))]
mod linux_app;
#[cfg(feature = "engine-bridge")]
pub use linux_app::bridge::{run_bridge, run_bridge_vsock};
#[cfg(not(target_os = "macos"))]
pub use linux_app::bundled_layout;
#[cfg(all(not(target_os = "macos"), feature = "window"))]
pub use linux_app::run;

#[cfg(all(target_os = "macos", feature = "window"))]
mod macos_app;
#[cfg(all(target_os = "macos", feature = "window"))]
pub use macos_app::run;
