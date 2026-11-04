//! Seamless macOS workspaces: project folders on the Mac, executed by the Linux engine, with
//! verified results applied back. Portable modules (everything but the engine registration) so
//! host and guest logic are exercised together in tests without a VM.
//!
//! * [`policy`] / [`manifest`] — what travels, hashed and bounded, with collisions detected
//! * [`guest`] — the guest-side staging root: versioned, resumable, verified, atomic publication
//! * [`registry`] / [`journal`] — durable host state (projects, consent, runs, writeback journal)
//! * [`host`] — stage to the guest, export from it, apply with conflict protection and recovery

pub mod coordinator;
pub mod guest;
pub mod host;
pub mod manifest;
pub mod policy;
pub mod registry;
pub mod wire;
