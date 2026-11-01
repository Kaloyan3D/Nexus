//! Kernel enforcement without namespace/cgroup prerequisites. A fresh subprocess
//! installs the production filter; installation failure is a test failure.
#![cfg(all(
    target_os = "linux",
    target_endian = "little",
    any(target_arch = "x86_64", target_arch = "aarch64")
))]

use nexus_tools::sandbox::seccomp_program;
use std::os::unix::process::ExitStatusExt;

#[test]
fn native_filter_kernel_enforcement() {
    const CHILD: &str = "NEXUS_SECCOMP_TEST_CHILD";
    if let Ok(mode) = std::env::var(CHILD) {
        let mut bytes = seccomp_program();
        if mode == "wrong-arch" {
            // Make the ABI guard deliberately reject this process.
            bytes[12..16].copy_from_slice(&0u32.to_ne_bytes());
        }
        let ins: Vec<libc::sock_filter> = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|b| libc::sock_filter {
                code: u16::from_ne_bytes(b[..2].try_into().unwrap()),
                jt: b[2],
                jf: b[3],
                k: u32::from_ne_bytes(b[4..].try_into().unwrap()),
            })
            .collect();
        let prog = libc::sock_fprog {
            len: ins.len().try_into().unwrap(),
            filter: ins.as_ptr().cast_mut(),
        };
        unsafe {
            assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0);
            assert_eq!(libc::prctl(libc::PR_SET_SECCOMP, 2, &prog), 0);
            // A wrong-ABI filter kills the first syscall, including getpid.
            assert!(libc::syscall(libc::SYS_getpid) > 0);
            assert_eq!(libc::syscall(libc::SYS_ptrace, 0, 0, 0, 0), -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM)
            );
            // personality(0xffffffff) only queries the current personality;
            // EPERM here proves a policy denial of an otherwise harmless call.
            assert_eq!(libc::syscall(libc::SYS_personality, 0xffffffffu64), -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM)
            );
            assert_eq!(
                libc::syscall(libc::SYS_clone3, std::ptr::null::<u8>(), 0usize),
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ENOSYS)
            );
        }
        return;
    }
    for mode in ["native", "wrong-arch"] {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_filter_kernel_enforcement", "--nocapture"])
            .env(CHILD, mode)
            .status()
            .unwrap();
        if mode == "wrong-arch" {
            assert_eq!(status.signal(), Some(libc::SIGSYS));
        } else {
            assert!(
                status.success(),
                "native filter enforcement failed: {status}"
            );
        }
    }
}

#[cfg(target_arch = "aarch64")]
#[test]
fn aarch64_policy_uses_native_numbers_and_rejects_compat_abi() {
    let bytes = seccomp_program();
    assert_eq!(
        u32::from_ne_bytes(bytes[12..16].try_into().unwrap()),
        0xc00000b7
    );
    let denied: Vec<u32> = bytes
        .as_chunks::<8>()
        .0
        .iter()
        .skip(4)
        .filter(|b| u16::from_ne_bytes(b[..2].try_into().unwrap()) == 0x15)
        .map(|b| u32::from_ne_bytes(b[4..].try_into().unwrap()))
        .collect();
    for nr in [
        libc::SYS_ptrace,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_chroot,
        libc::SYS_setns,
        libc::SYS_unshare,
        libc::SYS_bpf,
        libc::SYS_keyctl,
        libc::SYS_io_uring_setup,
        libc::SYS_clone3,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_mount_setattr,
    ] {
        assert!(denied.contains(&(nr as u32)), "missing denial for {nr}");
    }
    // x86_64's ptrace number is AArch64 nanosleep: do not deny it by accident.
    assert!(!denied.contains(&101));
}
