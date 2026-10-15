//! `fs.write` / `fs.edit` executor: the write lifecycle state machine.
//!
//! ```text
//! authorized ─► started ─► planned ─► prepared ─► applied ─► verified
//!   (grant)     (verify)   (intent    (temp file   (rename +   (re-read
//!                          durable)   fsynced)     dir fsync)  == post)
//!                   └──────────► failed | conflict | interrupted
//! ```
//!
//! Durability points (each journal append is a committed SQLite
//! transaction, `synchronous=FULL`, *before* the next step begins):
//! * `planned`  — before any filesystem mutation, including the temp file.
//!   Carries path, operation, pre/post sha256 and sizes, and the temp name.
//! * `prepared` — after the temp file is written, `fchmod`ed and `fsync`ed,
//!   before publication.
//! * `applied`  — after the atomic rename **and** parent-directory fsync.
//!   A crash between the rename and this record leaves "mutation may have
//!   occurred": restart reconciliation observes the target and records an
//!   explicit `interrupted` outcome. It never replays and never invents
//!   `applied`/`verified`.
//! * `verified` — after re-reading the published file and matching the
//!   planned post-image hash.
//!
//! Fencing: the authoritative fence is checked before the temp file and
//! again immediately before publication. After publication the write is
//! *not* aborted; the outcome is recorded truthfully.

use crate::contract::{EditArgs, ToolArgs, ToolBudgets, WriteArgs};
use crate::exec::CancellationToken;
use crate::mutate::{self, crash_point};
use crate::redact::Redaction;
use crate::result::{ToolError, ToolErrorCode, ToolResultV1, ToolStats, Truncation};
use crate::workspace::{RelPath, Workspace};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::os::fd::AsRawFd;

pub trait WriteHooks {
    /// Durably journal one lifecycle phase (blocks until committed).
    fn journal(&mut self, phase: &str, payload: serde_json::Value) -> Result<(), ToolError>;
    /// Authoritative fence probe (lease/generation/revocation).
    fn fence(&mut self) -> Result<(), ToolError>;
    /// Deterministic synchronization point (tests inject external
    /// activity here). Production hooks leave the default no-op.
    fn at(&mut self, _point: &str) {}
}

pub fn sha256_bytes_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

pub fn temp_name(execution_id: &str) -> String {
    let id: String = execution_id.chars().take(24).collect();
    format!(".nexus-tmp-{id}")
}

enum Op<'a> {
    Write(&'a WriteArgs),
    Edit(&'a EditArgs),
}

fn out_ok(
    tool: &str,
    path: &str,
    op: &str,
    pre: Option<&str>,
    post: &str,
    bytes: u64,
) -> ToolResultV1 {
    let output = serde_json::json!({
        "path": path,
        "operation": op,
        "state": "verified",
        "preSha256": pre,
        "postSha256": post,
        "bytes": bytes,
    });
    ToolResultV1::success(
        tool,
        crate::contract::TOOL_VERSION,
        output,
        Truncation::default(),
        Redaction::default(),
        ToolStats::default(),
    )
}

fn out_err(tool: &str, e: ToolError) -> ToolResultV1 {
    ToolResultV1::failure(tool, crate::contract::TOOL_VERSION, e, ToolStats::default())
}

fn read_bounded(f: std::fs::File, max: u64) -> Result<Vec<u8>, ToolError> {
    let mut v = Vec::new();
    f.take(max + 1)
        .read_to_end(&mut v)
        .map_err(|_| ToolError::new(ToolErrorCode::IoError, "read failed"))?;
    if v.len() as u64 > max {
        return Err(ToolError::new(
            ToolErrorCode::FileTooLarge,
            "target exceeds the size budget",
        ));
    }
    Ok(v)
}

/// Run one mutating tool call to a terminal lifecycle state.
///
/// `Ok(result)` carries the terminal outcome (verified / conflict /
/// failed). `Err` means a journal write failed after the filesystem may
/// have changed: the caller must treat the outcome as uncertain and let
/// restart reconciliation classify it.
pub fn run_write(
    ws: &Workspace,
    args: &ToolArgs,
    budgets: &ToolBudgets,
    execution_id: &str,
    cancel: &CancellationToken,
    hooks: &mut dyn WriteHooks,
) -> Result<ToolResultV1, ToolError> {
    let (op, tool, path_s) = match args {
        ToolArgs::Write(a) => (Op::Write(a), "fs.write", a.path.as_str()),
        ToolArgs::Edit(a) => (Op::Edit(a), "fs.edit", a.path.as_str()),
        _ => {
            return Ok(out_err(
                "fs.write",
                ToolError::new(ToolErrorCode::UnsupportedTool, "not a mutating tool"),
            ))
        }
    };
    macro_rules! refuse_none {
        ($code:expr, $msg:expr) => {{
            let e = ToolError::new($code, $msg);
            hooks.journal(
                crate::write::PH_FAILED,
                serde_json::json!({"mutation": "none", "errorCode": e.code.as_str(), "reason": e.message}),
            )?;
            return Ok(out_err(tool, e));
        }};
    }
    macro_rules! conflict {
        ($why:expr, $msg:expr) => {{
            let e = ToolError::new(ToolErrorCode::Conflict, $msg);
            hooks.journal(
                crate::write::PH_CONFLICT,
                serde_json::json!({"mutation": "none", "errorCode": "conflict", "conflict": $why, "reason": e.message}),
            )?;
            return Ok(out_err(tool, e));
        }};
    }

    let rel = match RelPath::parse(path_s) {
        Ok(r) => r,
        Err(e) => refuse_none!(e.code, e.message),
    };
    let (dir, name) = match ws.open_parent_for_write(&rel) {
        Ok(v) => v,
        Err(e) => refuse_none!(e.code, e.message),
    };
    let max_write = budgets.max_write_bytes;
    let new_len_hint = match &op {
        Op::Write(a) => a.content.len() as u64,
        Op::Edit(_) => 0,
    };
    if new_len_hint > max_write {
        refuse_none!(
            ToolErrorCode::FileTooLarge,
            "content exceeds the write budget"
        );
    }

    // 1. Observe the target (no mutation yet).
    let existing = match ws.stat_in_dir(&dir.fd, &name) {
        Ok(v) => v,
        Err(e) => refuse_none!(e.code, e.message),
    };
    let (pre_bytes, pre_sha, pre_mode): (Option<Vec<u8>>, Option<String>, Option<u32>) =
        match existing {
            None => (None, None, None),
            Some(_) => {
                let o = match ws.open_file_in_dir(&dir.fd, &name) {
                    Ok(o) => o,
                    Err(e) => refuse_none!(e.code, e.message),
                };
                let mode = o.identity.mode;
                // Metadata Nexus cannot preserve is a refusal, never a
                // silent loss: special mode bits, a different owner and
                // user/ACL xattrs all fail closed with no mutation.
                if o.identity.mode & 0o7000 != 0 {
                    conflict!(
                        "special-mode-bits",
                        "target has setuid/setgid/sticky bits; replacement refused"
                    );
                }
                if o.identity.uid != unsafe { libc::geteuid() } {
                    conflict!(
                        "owner-differs",
                        "target is owned by another user; replacement would change ownership"
                    );
                }
                if mutate::has_unpreservable_xattrs(o.fd.as_raw_fd()) {
                    conflict!(
                        "xattr-present",
                        "target carries user/ACL extended attributes that replacement would drop"
                    );
                }
                let bytes = match read_bounded(std::fs::File::from(o.fd), budgets.max_file_bytes) {
                    Ok(b) => b,
                    Err(e) => refuse_none!(e.code, e.message),
                };
                let sha = sha256_bytes_hex(&bytes);
                (Some(bytes), Some(sha), Some(mode))
            }
        };

    // 2. Decide the post-image and check expectations. Never silently
    //    overwrite an unexpected state.
    let (post, file_mode, op_name): (Vec<u8>, u32, &str) = match &op {
        Op::Write(a) if a.mode == "create" => {
            if pre_bytes.is_some() {
                conflict!("target-exists", "create refused: the target already exists");
            }
            let mode = a
                .file_mode
                .as_deref()
                .and_then(|m| u32::from_str_radix(m, 8).ok())
                .unwrap_or(0o644);
            (a.content.clone().into_bytes(), mode, "create")
        }
        Op::Write(a) => {
            let Some(cur) = &pre_sha else {
                conflict!(
                    "target-absent",
                    "replace refused: the target does not exist"
                );
            };
            if Some(cur) != a.expected_sha256.as_ref() {
                conflict!(
                    "preimage-mismatch",
                    "replace refused: the file changed since it was read"
                );
            }
            (
                a.content.clone().into_bytes(),
                pre_mode.unwrap_or(0o644),
                "replace",
            )
        }
        Op::Edit(a) => {
            let Some(cur) = &pre_sha else {
                conflict!("target-absent", "edit refused: the target does not exist");
            };
            if cur != &a.expected_sha256 {
                conflict!(
                    "preimage-mismatch",
                    "edit refused: the file changed since it was read"
                );
            }
            let mut text = match String::from_utf8(pre_bytes.clone().unwrap_or_default()) {
                Ok(t) => t,
                Err(_) => {
                    refuse_none!(ToolErrorCode::InvalidUtf8, "edit target is not valid UTF-8")
                }
            };
            for (i, e) in a.edits.iter().enumerate() {
                let n = text.matches(e.old_text.as_str()).count();
                if n == 0 {
                    conflict!(
                        format!("edit-{i}-not-found"),
                        "an edit's oldText was not found"
                    );
                }
                if n > 1 {
                    conflict!(
                        format!("edit-{i}-ambiguous"),
                        "an edit's oldText matches more than once"
                    );
                }
                text = text.replacen(e.old_text.as_str(), &e.new_text, 1);
            }
            (text.into_bytes(), pre_mode.unwrap_or(0o644), "edit")
        }
    };
    if post.len() as u64 > max_write {
        refuse_none!(
            ToolErrorCode::FileTooLarge,
            "resulting content exceeds the write budget"
        );
    }
    let post_sha = sha256_bytes_hex(&post);
    if pre_sha.as_deref() == Some(post_sha.as_str()) {
        conflict!(
            "no-change",
            "the requested change leaves the file byte-identical"
        );
    }
    let tmp = temp_name(execution_id);

    // 3. Fence, then make the INTENT durable before touching the disk.
    if cancel.is_cancelled() {
        refuse_none!(ToolErrorCode::Cancelled, "cancelled before any mutation");
    }
    if let Err(e) = hooks.fence() {
        refuse_none!(e.code, e.message);
    }
    hooks.journal(
        PH_PLANNED,
        serde_json::json!({
            "toolId": tool, "operation": op_name, "path": path_s,
            "preSha256": pre_sha, "preBytes": pre_bytes.as_ref().map(|b| b.len()),
            "postSha256": post_sha, "postBytes": post.len(), "fileMode": file_mode,
            "tmpName": tmp,
        }),
    )?;
    crash_point("after-planned");

    // 4. Prepare: private temp file in the same directory, fsynced.
    let tmp_fd = match mutate::create_temp(dir.fd.as_raw_fd(), &tmp) {
        Ok(f) => f,
        Err(e) => refuse_none!(e.code, e.message),
    };
    // Our temp inode's identity: later used to prove which inode we may
    // unlink, and recorded in `prepared` for crash recovery.
    let tmp_id = mutate::fd_identity(tmp_fd.as_raw_fd());
    let prep = (|| -> Result<(), ToolError> {
        mutate::write_all(tmp_fd.as_raw_fd(), &post)?;
        mutate::fchmod(tmp_fd.as_raw_fd(), file_mode)?;
        mutate::fsync(tmp_fd.as_raw_fd())
    })();
    drop(tmp_fd);
    if let Err(e) = prep {
        remove_own_temp(dir.fd.as_raw_fd(), &tmp, tmp_id);
        refuse_none!(e.code, e.message);
    }
    hooks.journal(
        PH_PREPARED,
        serde_json::json!({
            "tmpName": tmp, "postSha256": post_sha,
            "tmpDev": tmp_id.map(|i| i.0), "tmpIno": tmp_id.map(|i| i.1),
        }),
    )?;
    crash_point("after-prepared");

    // 5. Last fence before the irreversible step.
    let pre_publish = if cancel.is_cancelled() {
        Err(ToolError::new(
            ToolErrorCode::Cancelled,
            "cancelled before publication",
        ))
    } else {
        hooks.fence()
    };
    if let Err(e) = pre_publish {
        remove_own_temp(dir.fd.as_raw_fd(), &tmp, tmp_id);
        refuse_none!(e.code, e.message);
    }

    // 6. Publish atomically.
    let dfd = dir.fd.as_raw_fd();
    match &pre_sha {
        None => match mutate::renameat2(dfd, &tmp, &name, mutate::RENAME_NOREPLACE) {
            Ok(()) => {}
            Err(e) if e == libc::EEXIST => {
                remove_own_temp(dfd, &tmp, tmp_id);
                conflict!(
                    "target-created-concurrently",
                    "the target appeared before publication"
                );
            }
            Err(e) => {
                remove_own_temp(dfd, &tmp, tmp_id);
                let code = if e == libc::EINVAL || e == libc::ENOSYS || e == libc::EOPNOTSUPP {
                    ToolErrorCode::UnsupportedFilesystem
                } else {
                    ToolErrorCode::WriteFailed
                };
                refuse_none!(code, format!("atomic create unavailable (errno {e})"));
            }
        },
        Some(expected) => {
            match mutate::renameat2(dfd, &tmp, &name, mutate::RENAME_EXCHANGE) {
                Ok(()) => {}
                Err(e) => {
                    remove_own_temp(dfd, &tmp, tmp_id);
                    let code = if e == libc::EINVAL || e == libc::ENOSYS || e == libc::EOPNOTSUPP {
                        ToolErrorCode::UnsupportedFilesystem
                    } else {
                        ToolErrorCode::WriteFailed
                    };
                    refuse_none!(code, format!("atomic exchange unavailable (errno {e})"));
                }
            }
            hooks.at("after-exchange");
            crash_point("after-exchange");
            // `name` now holds OUR inode; `tmp` holds exactly the inode
            // that was replaced. Hash THAT inode (not a path guess).
            let displaced = ws.open_file_in_dir(&dir.fd, &tmp).ok();
            let displaced_id = displaced.as_ref().map(|o| (o.identity.dev, o.identity.ino));
            let displaced_matches = displaced
                .and_then(|o| read_bounded(std::fs::File::from(o.fd), budgets.max_file_bytes).ok())
                .map(|b| &sha256_bytes_hex(&b) == expected)
                .unwrap_or(false);
            if !displaced_matches {
                // The target was not the expected pre-image at the instant
                // of publication. Undo NON-DESTRUCTIVELY.
                match reverse_publication(ws, &dir, &name, &tmp, tmp_id, &post_sha, execution_id) {
                    Ok(Reversal::Restored) => {
                        let _ = mutate::fsync(dfd);
                        conflict!(
                            "concurrent-modification",
                            "the target changed during publication; original restored"
                        );
                    }
                    Ok(Reversal::RestoredOursModified(kept)) => {
                        let _ = mutate::fsync(dfd);
                        let e = ToolError::new(
                            ToolErrorCode::Conflict,
                            "the target changed during publication; original restored; an external write to the briefly published file was preserved",
                        );
                        hooks.journal(
                            PH_CONFLICT,
                            serde_json::json!({
                                "mutation": "none", "errorCode": "conflict",
                                "conflict": "concurrent-modification",
                                "preservedAs": kept, "reason": e.message,
                            }),
                        )?;
                        return Ok(out_err(tool, e));
                    }
                    Ok(Reversal::ForeignPreserved(kept)) => {
                        let _ = mutate::fsync(dfd);
                        let e = ToolError::new(
                            ToolErrorCode::Conflict,
                            "the target was replaced by another writer during publication; their file is intact and the displaced earlier file was preserved",
                        );
                        hooks.journal(
                            PH_CONFLICT,
                            serde_json::json!({
                                "mutation": "none", "errorCode": "conflict",
                                "conflict": "concurrent-replacement",
                                "preservedAs": kept, "reason": e.message,
                            }),
                        )?;
                        return Ok(out_err(tool, e));
                    }
                    Err(errno) => {
                        hooks.journal(
                            PH_FAILED,
                            serde_json::json!({
                                "mutation": "uncertain",
                                "errorCode": "published-unverified",
                                "reason": format!("could not undo publication (errno {errno})"),
                                "tmpName": tmp,
                            }),
                        )?;
                        return Ok(out_err(
                            tool,
                            ToolError::new(
                                ToolErrorCode::PublishedUnverified,
                                "target changed during publication and could not be restored",
                            ),
                        ));
                    }
                }
            }
            crash_point("after-rename");
            // Remove exactly the inode we hashed (the verified pre-image).
            if let Some(id) = displaced_id {
                let _ = mutate::unlink_if_identity(dfd, &tmp, id);
            }
        }
    }
    if pre_sha.is_none() {
        crash_point("after-rename");
    }
    let sync = mutate::fsync(dfd);

    // 7. From here the bytes ARE published: never abort, record truth.
    hooks.journal(
        PH_APPLIED,
        serde_json::json!({"postSha256": post_sha, "dirSynced": sync.is_ok()}),
    )?;
    crash_point("after-applied");

    // 8. Verify by re-reading what is actually on disk.
    let observed = ws
        .open_file_in_dir(&dir.fd, &name)
        .ok()
        .and_then(|o| {
            read_bounded(
                std::fs::File::from(o.fd),
                max_write.max(budgets.max_file_bytes),
            )
            .ok()
        })
        .map(|b| sha256_bytes_hex(&b));
    if observed.as_deref() == Some(post_sha.as_str()) && sync.is_ok() {
        hooks.journal(
            PH_VERIFIED,
            serde_json::json!({
                "toolId": tool, "operation": op_name, "path": path_s,
                "preSha256": pre_sha, "postSha256": post_sha, "postBytes": post.len(),
                "mutation": "applied",
            }),
        )?;
        Ok(out_ok(
            tool,
            path_s,
            op_name,
            pre_sha.as_deref(),
            &post_sha,
            post.len() as u64,
        ))
    } else {
        hooks.journal(
            PH_FAILED,
            serde_json::json!({
                "mutation": "published-unverified",
                "errorCode": "published-unverified",
                "observedSha256": observed,
                "postSha256": post_sha,
                "dirSynced": sync.is_ok(),
            }),
        )?;
        Ok(out_err(
            tool,
            ToolError::new(
                ToolErrorCode::PublishedUnverified,
                "bytes were published but verification did not match the planned post-image",
            ),
        ))
    }
}

enum Reversal {
    /// Original restored; our (unmodified) inode discarded.
    Restored,
    /// Original restored; someone wrote into our briefly-published inode;
    /// that inode was kept under the given name instead of deleted.
    RestoredOursModified(String),
    /// Another writer replaced the name with their own file while we were
    /// reversing; their file is back in place and the earlier displaced
    /// file was kept under the given name.
    ForeignPreserved(String),
}

fn remove_own_temp(dir: i32, tmp: &str, id: Option<(u64, u64)>) {
    // Identity unknown (fstat failed): leave it for reconciliation rather
    // than delete by name.
    if let Some(i) = id {
        let _ = mutate::unlink_if_identity(dir, tmp, i);
    }
}

/// Non-destructive undo of an exchange whose displaced inode was not the
/// expected pre-image. Invariant: no inode is unlinked unless it is
/// verified to be our own unmodified temp.
///
/// `name` <-> `tmp` are exchanged back. Then:
/// * `tmp` holds our inode: delete it only if it is byte-identical to the
///   post-image (nobody wrote into it); otherwise keep it renamed aside.
/// * `tmp` holds a foreign inode (another writer replaced `name` during the
///   window): exchange again so their file is back at `name`, and rename the
///   displaced earlier file aside instead of deleting it.
fn reverse_publication(
    ws: &Workspace,
    dir: &crate::workspace::Opened,
    name: &str,
    tmp: &str,
    ours: Option<(u64, u64)>,
    post_sha: &str,
    execution_id: &str,
) -> Result<Reversal, i32> {
    let dfd = dir.fd.as_raw_fd();
    mutate::renameat2(dfd, tmp, name, mutate::RENAME_EXCHANGE)?;
    let at_tmp = mutate::entry_identity(dfd, tmp);
    let tag: String = execution_id.chars().take(24).collect();
    if at_tmp.is_some() && at_tmp == ours {
        let intact = ws
            .open_file_in_dir(&dir.fd, tmp)
            .ok()
            .and_then(|o| read_bounded(std::fs::File::from(o.fd), 8 * 1024 * 1024).ok())
            .map(|b| sha256_bytes_hex(&b) == post_sha)
            .unwrap_or(false);
        if intact {
            if let Some(id) = ours {
                let _ = mutate::unlink_if_identity(dfd, tmp, id);
            }
            return Ok(Reversal::Restored);
        }
        let kept = format!(".nexus-conflict-{tag}");
        mutate::rename_aside(dfd, tmp, &kept)?;
        return Ok(Reversal::RestoredOursModified(kept));
    }
    // Foreign inode at `tmp`: put it back, keep what we displaced.
    mutate::renameat2(dfd, tmp, name, mutate::RENAME_EXCHANGE)?;
    let kept = format!(".nexus-displaced-{tag}");
    mutate::rename_aside(dfd, tmp, &kept)?;
    Ok(Reversal::ForeignPreserved(kept))
}

pub const PH_PLANNED: &str = "planned";
pub const PH_PREPARED: &str = "prepared";
pub const PH_APPLIED: &str = "applied";
pub const PH_VERIFIED: &str = "verified";
pub const PH_FAILED: &str = "failed";
pub const PH_CONFLICT: &str = "conflict";

/// Observe a target after a crash and describe what is known. Also
/// removes an abandoned temp file that was never published. Never
/// modifies the target.
pub fn observe_for_recovery(
    ws: &Workspace,
    planned: &serde_json::Value,
    prepared: &serde_json::Value,
) -> serde_json::Value {
    let path = planned.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let pre = planned.get("preSha256").and_then(|v| v.as_str());
    let post = planned.get("postSha256").and_then(|v| v.as_str());
    let tmp = planned.get("tmpName").and_then(|v| v.as_str());
    let Ok(rel) = RelPath::parse(path) else {
        return serde_json::json!({"observed": "unobservable", "mutation": "uncertain"});
    };
    let Ok((dir, name)) = ws.open_parent_for_write(&rel) else {
        return serde_json::json!({"observed": "unobservable", "mutation": "uncertain"});
    };
    let digest = match ws.stat_in_dir(&dir.fd, &name) {
        Ok(None) => Some(None),
        Ok(Some(_)) => ws
            .open_file_in_dir(&dir.fd, &name)
            .ok()
            .and_then(|o| read_bounded(std::fs::File::from(o.fd), 8 * 1024 * 1024).ok())
            .map(|b| Some(sha256_bytes_hex(&b))),
        Err(_) => None,
    };
    let (observed, mutation) = match &digest {
        None => ("unobservable", "uncertain"),
        Some(Some(d)) if Some(d.as_str()) == post => ("post-image-present", "applied-unverified"),
        Some(Some(d)) if Some(d.as_str()) == pre => ("pre-image-intact", "none"),
        Some(None) if pre.is_none() => ("pre-image-intact", "none"),
        Some(_) => ("diverged", "uncertain"),
    };
    // Temp-name handling. The temp name can hold (a) our own unpublished
    // temp, or (b) after a crash following `RENAME_EXCHANGE`, the file that
    // was displaced from the target. Only (a) and a verified-expected
    // pre-image may be removed; anything else is preserved.
    let mut tmp_removed = false;
    let mut displaced_removed = false;
    let mut displaced_preserved = false;
    let mut preserved_as: Option<String> = None;
    let mut over_unexpected = false;
    if let Some(t) = tmp {
        if t.starts_with(".nexus-tmp-") {
            let dfd = dir.fd.as_raw_fd();
            if let Some(id) = mutate::entry_identity(dfd, t) {
                let ours = match (
                    prepared.get("tmpDev").and_then(|v| v.as_u64()),
                    prepared.get("tmpIno").and_then(|v| v.as_u64()),
                ) {
                    (Some(d), Some(i)) => Some((d, i)),
                    _ => None,
                };
                let never_exchanged = prepared.get("tmpName").is_none();
                if never_exchanged || Some(id) == ours {
                    // Our own never-published temp (no exchange can have
                    // happened before `prepared` was journaled).
                    tmp_removed = mutate::unlink_if_identity(dfd, t, id).unwrap_or(false);
                } else {
                    let content_sha = ws
                        .open_file_in_dir(&dir.fd, t)
                        .ok()
                        .and_then(|o| read_bounded(std::fs::File::from(o.fd), 8 * 1024 * 1024).ok())
                        .map(|b| sha256_bytes_hex(&b));
                    if content_sha.is_some() && content_sha.as_deref() == pre {
                        // Exactly the expected pre-image displaced by a
                        // successful exchange: same disposal as the
                        // success path.
                        displaced_removed = mutate::unlink_if_identity(dfd, t, id).unwrap_or(false);
                    } else {
                        let tag: String = t
                            .trim_start_matches(".nexus-tmp-")
                            .chars()
                            .take(24)
                            .collect();
                        let kept = format!(".nexus-displaced-{tag}");
                        if mutate::rename_aside(dfd, t, &kept).is_ok() {
                            displaced_preserved = true;
                            preserved_as = Some(kept);
                        }
                        over_unexpected = true;
                    }
                }
            }
        }
    }
    serde_json::json!({
        "reason": "no terminal record (crash or restart); never re-executed",
        "observed": observed,
        "mutation": mutation,
        "observedSha256": digest.flatten(),
        "tmpRemoved": tmp_removed,
        "displacedRemoved": displaced_removed,
        "displacedPreserved": displaced_preserved,
        "preservedAs": preserved_as,
        "publishedOverUnexpectedPreImage": over_unexpected,
    })
}
