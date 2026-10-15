//! `fs.search`: bounded literal substring search with explicit-stack,
//! deterministic traversal. No regex (no ReDoS surface), no recursion.

use crate::contract::SearchArgs;
use crate::exec::ExecCtx;
use crate::read::{clip, trim_eol, LineReader};
use crate::redact::Redactor;
use crate::result::{ToolError, ToolErrorCode};
use crate::workspace::{Kind, NameClass, RelPath};

struct Matcher {
    needle: String,
    fold: bool,
}

impl Matcher {
    fn hit(&self, line: &str) -> bool {
        if self.fold {
            line.to_lowercase().contains(&self.needle)
        } else {
            line.contains(&self.needle)
        }
    }
}

enum FileOutcome {
    Done,
    Stop,
}

#[allow(clippy::too_many_arguments)]
fn scan_file(
    ctx: &mut ExecCtx<'_>,
    rel: &RelPath,
    m: &Matcher,
    matches: &mut Vec<serde_json::Value>,
    out_bytes: &mut u64,
    max_matches: usize,
    strict: bool,
) -> Result<FileOutcome, ToolError> {
    let opened = match ctx.ws.open_file(rel) {
        Ok(o) => o,
        // Entries found by traversal that disappear/change are skipped;
        // an explicitly requested file reports the real error.
        Err(e) if !strict => {
            match e.code {
                ToolErrorCode::SymlinkRefused => ctx.stats.skipped_symlinks += 1,
                ToolErrorCode::SpecialFileRefused => ctx.stats.skipped_special += 1,
                ToolErrorCode::HardlinkRefused => ctx.stats.skipped_hardlinks += 1,
                ToolErrorCode::MountCrossing => ctx.stats.skipped_mount_crossing += 1,
                _ => {}
            }
            return Ok(FileOutcome::Done);
        }
        Err(e) => return Err(e),
    };
    if opened.identity.size > ctx.budgets.max_file_bytes {
        if strict {
            return Err(ToolError::new(
                ToolErrorCode::FileTooLarge,
                "file exceeds the size budget",
            ));
        }
        ctx.stats.skipped_large += 1;
        return Ok(FileOutcome::Done);
    }
    if ctx.stats.bytes_read + opened.identity.size > ctx.budgets.max_scan_bytes {
        ctx.truncation.add("max-scan-bytes");
        return Ok(FileOutcome::Stop);
    }
    let mut rd = LineReader::new(opened.fd, ctx.budgets.max_file_bytes);
    if rd.looks_binary()? {
        if strict {
            return Err(ToolError::new(
                ToolErrorCode::BinaryFile,
                "binary files are not searchable as text",
            ));
        }
        ctx.stats.skipped_binary += 1;
        return Ok(FileOutcome::Done);
    }
    ctx.stats.files_scanned += 1;
    let mut buf = Vec::new();
    let mut line_no = 0u64;
    let disp = rel.display();
    let mut outcome = FileOutcome::Done;
    let mut redactor = Redactor::new();
    loop {
        let more = rd.next_line(&mut buf);
        let more = match more {
            Ok(m) => m,
            Err(e) if e.code == ToolErrorCode::FileTooLarge && !strict => {
                ctx.stats.skipped_large += 1;
                break;
            }
            Err(e) => return Err(e),
        };
        if !more {
            break;
        }
        line_no += 1;
        if line_no.is_multiple_of(512) {
            ctx.check_cancel()?;
            if ctx.deadline_exceeded() {
                ctx.truncation.add("deadline");
                outcome = FileOutcome::Stop;
                break;
            }
        }
        if buf.contains(&0) {
            ctx.stats.skipped_binary += 1;
            break;
        }
        let Ok(text) = std::str::from_utf8(trim_eol(&buf)) else {
            ctx.stats.skipped_invalid_utf8 += 1;
            break;
        };
        // Match against the *redacted* line: search must not be a prefix
        // oracle for redacted secrets. Only matched lines are counted.
        let mut line_red = crate::redact::Redaction::default();
        let safe = redactor.line(text, &mut line_red);
        if !m.hit(&safe) {
            continue;
        }
        for k in &line_red.kinds {
            ctx.redaction.note(k, 1);
        }
        let (shown, was_clipped) = clip(&safe, ctx.budgets.max_line_bytes as usize);
        if was_clipped {
            ctx.truncation.add("line-truncated");
        }
        let cost = (disp.len() + shown.len() + 40) as u64;
        if matches.len() >= max_matches {
            ctx.truncation.add("max-matches");
            outcome = FileOutcome::Stop;
            break;
        }
        if *out_bytes + cost > ctx.budgets.max_output_bytes {
            ctx.truncation.add("max-output-bytes");
            outcome = FileOutcome::Stop;
            break;
        }
        *out_bytes += cost;
        matches.push(serde_json::json!({ "path": disp, "line": line_no, "text": shown }));
    }
    ctx.stats.bytes_read += rd.bytes_read();
    Ok(outcome)
}

pub fn run(ctx: &mut ExecCtx<'_>, args: &SearchArgs) -> Result<serde_json::Value, ToolError> {
    ctx.check_cancel()?;
    let base = RelPath::parse(&args.path)?;
    let matcher = Matcher {
        fold: args.case_insensitive,
        needle: if args.case_insensitive {
            args.query.to_lowercase()
        } else {
            args.query.clone()
        },
    };
    let max_matches = args
        .max_matches
        .map(|m| m.min(ctx.budgets.max_matches))
        .unwrap_or(ctx.budgets.max_matches) as usize;
    let mut matches: Vec<serde_json::Value> = Vec::new();
    let mut out_bytes = 0u64;

    let first = ctx.ws.open_path(&base)?;
    if first.identity.kind == Kind::File {
        drop(first);
        scan_file(
            ctx,
            &base,
            &matcher,
            &mut matches,
            &mut out_bytes,
            max_matches,
            true,
        )?;
    } else {
        drop(first);
        // Explicit stack of (relative path, depth); popped smallest-first
        // because children are pushed in reverse byte order.
        let mut stack: Vec<(RelPath, u32)> = vec![(base.clone(), 0)];
        let mut dirs_seen = 0u32;
        let mut files_seen = 0u32;
        'walk: while let Some((dir, depth)) = stack.pop() {
            ctx.check_cancel()?;
            if ctx.deadline_exceeded() {
                ctx.truncation.add("deadline");
                break;
            }
            if dirs_seen >= ctx.budgets.max_dirs {
                ctx.truncation.add("max-dirs");
                break;
            }
            dirs_seen += 1;
            let opened = match ctx.ws.open_dir(&dir) {
                Ok(o) => o,
                Err(e) if !dir.is_root() && dir != base => {
                    if e.code == ToolErrorCode::SymlinkRefused {
                        ctx.stats.skipped_symlinks += 1;
                    }
                    continue;
                }
                Err(e) => return Err(e),
            };
            ctx.stats.dirs_visited += 1;
            let (raw, overflow) = ctx
                .ws
                .read_dir_names(&opened.fd, ctx.budgets.max_dir_entries_scan as usize)?;
            if overflow {
                ctx.truncation.add("directory-too-large");
                continue;
            }
            let mut names: Vec<(String, Kind)> = Vec::new();
            for e in raw {
                let Ok(name) = String::from_utf8(e.name.clone()) else {
                    ctx.stats.skipped_non_utf8_names += 1;
                    continue;
                };
                match ctx.ws.policy.classify_name(&name) {
                    NameClass::Hidden => {
                        ctx.stats.skipped_hidden += 1;
                        continue;
                    }
                    NameClass::Sensitive => {
                        ctx.stats.skipped_sensitive += 1;
                        continue;
                    }
                    NameClass::Allowed => {}
                }
                let id = ctx.ws.stat_entry(&opened.fd, &e.name)?;
                match id.kind {
                    Kind::Symlink => {
                        ctx.stats.skipped_symlinks += 1;
                        continue;
                    }
                    Kind::Special => {
                        ctx.stats.skipped_special += 1;
                        continue;
                    }
                    _ => {}
                }
                if !ctx.ws.same_mount(&id) {
                    ctx.stats.skipped_mount_crossing += 1;
                    continue;
                }
                if id.kind == Kind::Dir && ctx.ws.policy.is_ignored_dir(&name) {
                    ctx.stats.skipped_ignored += 1;
                    continue;
                }
                names.push((name, id.kind));
            }
            names.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            // Files of this directory first (in order), then descend.
            let mut subdirs: Vec<RelPath> = Vec::new();
            for (name, kind) in names {
                let child = dir.join(&name);
                match kind {
                    Kind::File => {
                        if files_seen >= ctx.budgets.max_files {
                            ctx.truncation.add("max-files");
                            break 'walk;
                        }
                        files_seen += 1;
                        let o = scan_file(
                            ctx,
                            &child,
                            &matcher,
                            &mut matches,
                            &mut out_bytes,
                            max_matches,
                            false,
                        )?;
                        if matches!(o, FileOutcome::Stop) {
                            break 'walk;
                        }
                    }
                    Kind::Dir => {
                        if depth + 1 > ctx.budgets.max_depth {
                            ctx.truncation.add("max-depth");
                        } else {
                            subdirs.push(child);
                        }
                    }
                    _ => {}
                }
            }
            for d in subdirs.into_iter().rev() {
                if stack.len() as u32 + dirs_seen >= ctx.budgets.max_dirs {
                    ctx.truncation.add("max-dirs");
                    break;
                }
                stack.push((d, depth + 1));
            }
        }
    }
    ctx.stats.matches_returned = matches.len() as u64;
    Ok(serde_json::json!({
        "query": { "length": args.query.len(), "caseInsensitive": args.case_insensitive },
        "path": base.display(),
        "matches": matches,
    }))
}
