//! `fs.list`: deterministic, bounded directory listing.

use crate::contract::ListArgs;
use crate::exec::ExecCtx;
use crate::result::{ToolError, ToolErrorCode};
use crate::workspace::{Kind, NameClass, RelPath};

pub fn run(ctx: &mut ExecCtx<'_>, args: &ListArgs) -> Result<serde_json::Value, ToolError> {
    ctx.check_cancel()?;
    let rel = RelPath::parse(&args.path)?;
    let opened = ctx.ws.open_dir(&rel)?;
    let (raw, overflow) = ctx
        .ws
        .read_dir_names(&opened.fd, ctx.budgets.max_dir_entries_scan as usize)?;
    if overflow {
        return Err(ToolError::new(
            ToolErrorCode::DirectoryTooLarge,
            "directory has more entries than the scan budget",
        ));
    }
    struct E {
        name: String,
        kind: &'static str,
        size: Option<u64>,
        ignored: bool,
    }
    let mut entries: Vec<E> = Vec::new();
    for (i, e) in raw.iter().enumerate() {
        if i % 256 == 0 {
            ctx.check_cancel()?;
        }
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
        if !ctx.ws.same_mount(&id) {
            ctx.stats.skipped_mount_crossing += 1;
            continue;
        }
        let (kind, size) = match id.kind {
            Kind::File => ("file", Some(id.size)),
            Kind::Dir => ("dir", None),
            Kind::Symlink => ("symlink", None),
            Kind::Special => ("special", None),
        };
        let ignored = id.kind == Kind::Dir && ctx.ws.policy.is_ignored_dir(&name);
        entries.push(E {
            name,
            kind,
            size,
            ignored,
        });
    }
    entries.sort_by(|a, b| a.name.as_bytes().cmp(b.name.as_bytes()));
    let mut out = Vec::new();
    let mut bytes = 0u64;
    for e in entries.iter() {
        let cost = e.name.len() as u64 + 48;
        if out.len() as u32 >= ctx.budgets.max_entries {
            ctx.truncation.add("max-entries");
            break;
        }
        if bytes + cost > ctx.budgets.max_output_bytes {
            ctx.truncation.add("max-output-bytes");
            break;
        }
        bytes += cost;
        let mut o = serde_json::json!({ "name": e.name, "kind": e.kind });
        if let Some(s) = e.size {
            o["size"] = serde_json::json!(s);
        }
        if e.ignored {
            o["ignored"] = serde_json::json!(true);
        }
        out.push(o);
    }
    ctx.stats.dirs_visited = 1;
    ctx.stats.entries_returned = out.len() as u64;
    Ok(serde_json::json!({ "path": rel.display(), "entries": out }))
}
