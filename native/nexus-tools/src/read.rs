//! `fs.read`: bounded, line-oriented read of one regular UTF-8 text file.

use crate::contract::ReadArgs;
use crate::exec::ExecCtx;
use crate::redact::{Redaction, Redactor};
use crate::result::{ToolError, ToolErrorCode};
use crate::workspace::RelPath;
use std::io::{BufRead, BufReader, Read};
use std::os::fd::OwnedFd;

/// Line iterator over a descriptor with a hard byte ceiling.
pub struct LineReader {
    inner: BufReader<std::io::Take<std::fs::File>>,
    ceiling: u64,
    total: u64,
}

impl LineReader {
    pub fn new(fd: OwnedFd, ceiling: u64) -> Self {
        let file = std::fs::File::from(fd);
        Self {
            inner: BufReader::with_capacity(16 * 1024, file.take(ceiling + 1)),
            ceiling,
            total: 0,
        }
    }

    /// First buffered chunk contains NUL => binary. Does not consume.
    pub fn looks_binary(&mut self) -> Result<bool, ToolError> {
        let buf = self
            .inner
            .fill_buf()
            .map_err(|_| ToolError::new(ToolErrorCode::IoError, "read failed"))?;
        Ok(buf.iter().take(8192).any(|b| *b == 0))
    }

    pub fn bytes_read(&self) -> u64 {
        self.total
    }

    /// Next line including terminator, or None at EOF.
    pub fn next_line(&mut self, buf: &mut Vec<u8>) -> Result<bool, ToolError> {
        buf.clear();
        let n = self
            .inner
            .read_until(b'\n', buf)
            .map_err(|_| ToolError::new(ToolErrorCode::IoError, "read failed"))?;
        if n == 0 {
            return Ok(false);
        }
        self.total += n as u64;
        if self.total > self.ceiling {
            return Err(ToolError::new(
                ToolErrorCode::FileTooLarge,
                "file grew beyond the size budget while reading",
            ));
        }
        Ok(true)
    }
}

pub fn trim_eol(line: &[u8]) -> &[u8] {
    let l = line.strip_suffix(b"\n").unwrap_or(line);
    l.strip_suffix(b"\r").unwrap_or(l)
}

/// Truncate to at most `max` bytes on a char boundary.
pub fn clip(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

pub fn run(ctx: &mut ExecCtx<'_>, args: &ReadArgs) -> Result<serde_json::Value, ToolError> {
    ctx.check_cancel()?;
    let rel = RelPath::parse(&args.path)?;
    if rel.is_root() {
        return Err(ToolError::new(
            ToolErrorCode::NotAFile,
            "path is a directory",
        ));
    }
    let opened = ctx.ws.open_file(&rel)?;
    if opened.identity.size > ctx.budgets.max_file_bytes {
        return Err(ToolError::new(
            ToolErrorCode::FileTooLarge,
            "file exceeds the size budget",
        ));
    }
    let mut rd = LineReader::new(opened.fd, ctx.budgets.max_file_bytes);
    if rd.looks_binary()? {
        return Err(ToolError::new(
            ToolErrorCode::BinaryFile,
            "binary files are not readable as text",
        ));
    }
    let start = args.start_line.unwrap_or(1) as u64;
    let max_lines = args.max_lines.unwrap_or(2000) as u64;
    let mut line_no = 0u64;
    let mut out = String::new();
    let mut returned = 0u64;
    let mut buf = Vec::new();
    let mut eof = true;
    let mut clipped = false;
    let mut redactor = Redactor::new();
    let mut scratch = Redaction::default();
    while rd.next_line(&mut buf)? {
        line_no += 1;
        if line_no.is_multiple_of(1024) {
            ctx.check_cancel()?;
            if ctx.deadline_exceeded() {
                ctx.truncation.add("deadline");
                eof = false;
                break;
            }
        }
        if buf.contains(&0) {
            return Err(ToolError::new(
                ToolErrorCode::BinaryFile,
                "binary content encountered",
            ));
        }
        if line_no < start {
            // Keep multi-line secret state (PEM blocks) correct across the
            // skipped prefix; counts from skipped lines are not reported.
            if let Ok(t) = std::str::from_utf8(trim_eol(&buf)) {
                redactor.line(t, &mut scratch);
            }
            continue;
        }
        if returned >= max_lines {
            ctx.truncation.add("max-lines");
            eof = false;
            break;
        }
        let text = std::str::from_utf8(trim_eol(&buf)).map_err(|e| {
            ToolError::new(
                ToolErrorCode::InvalidUtf8,
                format!("invalid UTF-8 at line {line_no}, byte {}", e.valid_up_to()),
            )
        })?;
        let safe = redactor.line(text, &mut ctx.redaction);
        let (shown, was_clipped) = clip(&safe, ctx.budgets.max_line_bytes as usize);
        clipped |= was_clipped;
        if out.len() as u64 + shown.len() as u64 + 1 > ctx.budgets.max_output_bytes {
            ctx.truncation.add("max-output-bytes");
            eof = false;
            break;
        }
        out.push_str(shown);
        out.push('\n');
        returned += 1;
    }
    if clipped {
        ctx.truncation.add("line-truncated");
    }
    ctx.stats.bytes_read = rd.bytes_read();
    ctx.stats.files_scanned = 1;
    Ok(serde_json::json!({
        "path": rel.display(),
        "content": out,
        "startLine": start,
        "linesReturned": returned,
        "eof": eof,
        "nextLine": if eof { serde_json::Value::Null } else { serde_json::json!(start + returned) },
    }))
}
