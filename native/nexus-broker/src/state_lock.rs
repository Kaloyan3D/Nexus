//! The broker's single-owner lock on its state directory (`<state_dir>/broker.lock`).
//!
//! Ownership is an exclusive `flock` on a descriptor this broker opened itself. `flock` locks
//! belong to the OPEN FILE DESCRIPTION, not to the descriptor or the process: a child forked by
//! ANY thread of this process holds a copy of that description from `fork` until `exec` (the
//! descriptor is close-on-exec, so it never outlives the `exec`). Releasing ownership by merely
//! closing our descriptor therefore leaves the lock held for as long as such a child sits
//! between fork and exec, and a broker restarted in that window is refused although the
//! previous one is gone (R-LOCK-1).
//!
//! [`StateLock`] releases the lock explicitly (`LOCK_UN`) when it is dropped. `LOCK_UN`
//! releases the lock of the description our descriptor refers to, whatever other copies exist,
//! and nothing else:
//! * a different broker can never be affected: it owns a description it opened itself (an
//!   exclusive lock cannot be held on two descriptions at once), and no broker ever uses a
//!   descriptor it inherited;
//! * a failed acquisition never constructs a `StateLock`, so it never releases anything;
//! * the release happens only when the `Broker` itself is dropped, i.e. after its last thread
//!   is gone (a worker still running past shutdown keeps the broker, and thus the lock, alive).

use std::fs::File;
use std::path::Path;

/// Refusal text for a state directory that another live broker owns.
pub const OWNED_ELSEWHERE: &str = "another broker already owns this state directory";

/// Exclusive ownership of a broker state directory, released when dropped.
#[derive(Debug)]
pub struct StateLock {
    file: File,
}

impl StateLock {
    /// Take ownership of `state_dir`, or fail at once if another broker owns it.
    pub fn acquire(state_dir: &Path) -> Result<Self, String> {
        use fs2::FileExt;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(state_dir.join("broker.lock"))
            .map_err(|e| format!("lock: {e}"))?;
        file.try_lock_exclusive()
            .map_err(|_| OWNED_ELSEWHERE.to_owned())?;
        Ok(Self { file })
    }
}

impl Drop for StateLock {
    fn drop(&mut self) {
        // Explicit, not implied by close: see the module documentation.
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::AsRawFd;

    /// A child forked from this process that keeps every inherited descriptor (it never execs)
    /// until `release` kills it: the deterministic stand-in for a child that sits between fork
    /// and exec while the broker shuts down. The child only calls `pause` (async-signal-safe);
    /// it is ended with SIGKILL, which - unlike waiting for a pipe to close - cannot be held up
    /// by descriptors that children forked concurrently by sibling tests inherited.
    struct ForkedHolder {
        pid: libc::pid_t,
    }

    impl ForkedHolder {
        fn spawn() -> Self {
            let pid = unsafe { libc::fork() };
            assert!(pid >= 0, "fork failed");
            if pid == 0 {
                loop {
                    unsafe { libc::pause() };
                }
            }
            Self { pid }
        }

        fn release(self) {
            drop(self); // kill + reap (Drop)
        }
    }

    impl Drop for ForkedHolder {
        fn drop(&mut self) {
            // also on a failing assertion: never leak a paused child
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
                let mut status = 0;
                libc::waitpid(self.pid, &mut status, 0);
            }
        }
    }

    #[test]
    fn ownership_is_released_on_drop_and_can_be_taken_again() {
        let dir = tempfile::tempdir().unwrap();
        for _ in 0..3 {
            let l = StateLock::acquire(dir.path()).expect("free");
            drop(l);
        }
    }

    #[test]
    fn a_second_owner_is_refused_while_the_first_one_lives() {
        let dir = tempfile::tempdir().unwrap();
        let a = StateLock::acquire(dir.path()).unwrap();
        assert_eq!(StateLock::acquire(dir.path()).unwrap_err(), OWNED_ELSEWHERE);
        // the refused attempt released nothing: still owned
        assert_eq!(StateLock::acquire(dir.path()).unwrap_err(), OWNED_ELSEWHERE);
        drop(a);
        StateLock::acquire(dir.path()).expect("free after the owner left");
    }

    /// The defect itself, deterministically: an inherited copy of the description keeps a
    /// lock that was released only by closing (the pre-R-LOCK-1 behaviour).
    #[test]
    fn closing_alone_leaves_the_lock_with_a_forked_child() {
        use fs2::FileExt;
        let dir = tempfile::tempdir().unwrap();
        let raw = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.path().join("broker.lock"))
            .unwrap();
        raw.try_lock_exclusive().unwrap();
        let child = ForkedHolder::spawn();
        drop(raw); // close only
        assert_eq!(
            StateLock::acquire(dir.path()).unwrap_err(),
            OWNED_ELSEWHERE,
            "the child's copy still holds the lock"
        );
        child.release();
        // Free once no child holds the description. Bounded wait: a child forked meanwhile by a
        // sibling test of this process may also hold a copy until it exits or execs (the very
        // effect this test documents).
        let end = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while StateLock::acquire(dir.path()).is_err() {
            assert!(std::time::Instant::now() < end, "never released");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    /// The fix: the same situation with a `StateLock`, and the single-owner guarantee intact
    /// afterwards (the child's copy is not an owner and cannot become one).
    #[test]
    fn a_forked_child_cannot_keep_a_released_lock() {
        let dir = tempfile::tempdir().unwrap();
        let a = StateLock::acquire(dir.path()).unwrap();
        let child = ForkedHolder::spawn();
        drop(a);
        let b = StateLock::acquire(dir.path()).expect("restart while the child still runs");
        assert_eq!(
            StateLock::acquire(dir.path()).unwrap_err(),
            OWNED_ELSEWHERE,
            "the new owner is exclusive"
        );
        child.release();
        assert_eq!(
            StateLock::acquire(dir.path()).unwrap_err(),
            OWNED_ELSEWHERE,
            "the child's exit does not release the new owner"
        );
        drop(b);
        StateLock::acquire(dir.path()).unwrap();
    }

    /// Releasing is scoped to our own description: unlocking any other descriptor of the same
    /// file (a refused contender, or a stale inherited copy) never frees the live owner.
    #[test]
    fn a_release_can_never_free_another_owners_lock() {
        use fs2::FileExt;
        let dir = tempfile::tempdir().unwrap();
        let owner = StateLock::acquire(dir.path()).unwrap();
        let other = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.path().join("broker.lock"))
            .unwrap();
        assert!(other.try_lock_exclusive().is_err());
        let _ = other.unlock();
        drop(other);
        assert_eq!(StateLock::acquire(dir.path()).unwrap_err(), OWNED_ELSEWHERE);
        // a child holding a copy of the OWNER's description, and the release of an old owner
        let child = ForkedHolder::spawn();
        assert_eq!(StateLock::acquire(dir.path()).unwrap_err(), OWNED_ELSEWHERE);
        drop(owner);
        let next = StateLock::acquire(dir.path()).unwrap();
        child.release();
        assert_eq!(StateLock::acquire(dir.path()).unwrap_err(), OWNED_ELSEWHERE);
        drop(next);
    }

    #[test]
    fn the_lock_descriptor_never_survives_an_exec() {
        let dir = tempfile::tempdir().unwrap();
        let l = StateLock::acquire(dir.path()).unwrap();
        let flags = unsafe { libc::fcntl(l.file.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0, "close-on-exec");
    }

    /// The production shape of the race: other threads keep spawning processes while the
    /// owner releases and a new owner acquires at once. With the explicit release a refusal is
    /// impossible, so this is deterministic in the passing direction (before R-LOCK-1 the same
    /// loop failed ~45% of iterations, see the R-LOCK-1 report).
    #[test]
    fn restarting_while_other_threads_spawn_children_never_fails() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let spawned = Arc::new(AtomicUsize::new(0));
        let storm: Vec<_> = (0..4)
            .map(|_| {
                let (stop, spawned) = (stop.clone(), spawned.clone());
                std::thread::spawn(move || {
                    while !stop.load(Ordering::SeqCst) {
                        let _ = std::process::Command::new("/bin/true").status();
                        spawned.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        while spawned.load(Ordering::SeqCst) < 20 {
            std::thread::yield_now();
        }
        let mut lock = StateLock::acquire(dir.path()).unwrap();
        let mut refused = 0;
        for _ in 0..2000 {
            drop(lock);
            lock = match StateLock::acquire(dir.path()) {
                Ok(l) => l,
                Err(_) => {
                    refused += 1;
                    loop {
                        if let Ok(l) = StateLock::acquire(dir.path()) {
                            break l;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(1));
                    }
                }
            };
        }
        stop.store(true, Ordering::SeqCst);
        for h in storm {
            h.join().unwrap();
        }
        assert!(spawned.load(Ordering::SeqCst) > 0, "the storm ran");
        assert_eq!(refused, 0, "no restart was refused");
    }
}
