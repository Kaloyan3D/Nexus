//! Conservative, bounded, line-oriented secret redaction for tool output.
//!
//! Boundary model (A3.1):
//! * *Raw authorized output* — file bytes after the path policy. Never
//!   leaves the executor unredacted.
//! * *Model-visible output* — the executor's return value: always passed
//!   through this redactor, and marked (`redaction.redacted`).
//! * *Persisted tool records* — journal payloads carry only counters,
//!   digests and redaction counts/kinds, never content.
//! * *UI diagnostics* — error messages are fixed strings without file
//!   content or host paths.
//!
//! This is pattern-based and therefore **incomplete by nature**: it catches
//! well-known token shapes, PEM private-key blocks and `name = value`
//! assignments whose name looks secret. It cannot detect arbitrary
//! high-entropy or context-dependent secrets, and it deliberately prefers
//! under-redaction of ordinary code to corrupting it. Redaction never
//! silently changes output: every affected result is flagged.
//!
//! Search matches against the *redacted* text, so `fs.search` cannot be used
//! as a prefix oracle to extract a redacted secret one character at a time.

use serde::{Deserialize, Serialize};

/// Inline marker for withheld content. Distinct from any common literal;
/// if the *source* itself contains it, the line is flagged
/// `marker-collision` so a consumer can never mistake source text for a
/// redaction.
pub const REDACTED: &str = "[REDACTED:nexus]";
/// Appended to a line that was clipped to the per-line byte budget.
pub const LINE_TRUNCATED: &str = " [TRUNCATED:nexus]";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redaction {
    pub redacted: bool,
    pub count: u64,
    pub kinds: Vec<String>,
}

impl Redaction {
    pub fn note(&mut self, kind: &str, n: u64) {
        if n == 0 {
            return;
        }
        self.redacted = true;
        self.count += n;
        if !self.kinds.iter().any(|k| k == kind) {
            self.kinds.push(kind.to_owned());
            self.kinds.sort();
        }
    }
}

#[derive(Default)]
pub struct Redactor {
    in_private_key: bool,
}

const SECRET_NAMES: &[&str] = &[
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "api-key",
    "private_key",
    "private-key",
    "access_key",
    "auth",
    "authorization",
    "credential",
    "client_secret",
];

fn is_tok(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || c == '_'
        || c == '-'
        || c == '.'
        || c == '/'
        || c == '+'
        || c == '='
}

/// Replace every maximal token that starts with `prefix` and has at least
/// `min_tail` token characters after it.
fn scrub_prefixed(line: &str, prefix: &str, min_tail: usize, out: &mut u64) -> String {
    let mut res = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find(prefix) {
        let after = &rest[i + prefix.len()..];
        let tail_len: usize = after
            .chars()
            .take_while(|c| is_tok(*c))
            .map(char::len_utf8)
            .sum();
        let tail_chars = after[..tail_len].chars().count();
        // Require a word boundary before the prefix to avoid mid-word hits.
        let boundary_ok = rest[..i]
            .chars()
            .next_back()
            .map(|c| !c.is_ascii_alphanumeric())
            .unwrap_or(true);
        if tail_chars >= min_tail && boundary_ok {
            res.push_str(&rest[..i]);
            res.push_str(REDACTED);
            *out += 1;
            rest = &after[tail_len..];
        } else {
            res.push_str(&rest[..i + prefix.len()]);
            rest = after;
        }
    }
    res.push_str(rest);
    res
}

fn looks_like_jwt(tok: &str) -> bool {
    let parts: Vec<&str> = tok.split('.').collect();
    parts.len() == 3
        && tok.starts_with("eyJ")
        && parts.iter().all(|p| {
            p.len() >= 8
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

fn is_placeholder(v: &str) -> bool {
    let l = v.to_ascii_lowercase();
    v.len() < 8
        || l.contains("example")
        || l.contains("changeme")
        || l.contains("placeholder")
        || l.contains("your_")
        || l.contains("<")
        || l.contains("${")
        || l.contains("{{")
        || l.starts_with("process.env")
        || l.starts_with("env(")
        || l.starts_with("os.environ")
        || l.chars().all(|c| c == '*' || c == 'x' || c == '.')
}

/// `NAME = "value"` / `NAME: value` with a secret-looking NAME.
fn scrub_assignment(line: &str, out: &mut u64) -> String {
    let lower = line.to_ascii_lowercase();
    let Some(sep) = line.find(['=', ':']) else {
        return line.to_owned();
    };
    let name = lower[..sep].trim_end_matches(['"', '\'', ' ', '\t']);
    let name_tail = name
        .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .next()
        .unwrap_or("");
    if !SECRET_NAMES.iter().any(|n| name_tail.contains(n)) {
        return line.to_owned();
    }
    // skip `==`, `:=`, `::`
    let after_sep = &line[sep + 1..];
    let value_raw = after_sep.trim_start_matches(['=', ' ', '\t']);
    let value = value_raw.trim_matches(['"', '\'', ',', ';', ' ']);
    if value.is_empty() || is_placeholder(value) || value.contains(' ') && value.len() > 80 {
        return line.to_owned();
    }
    // Only plain scalar values: skip things that look like code.
    if value.contains('(') || value.contains(')') || value.contains('[') {
        return line.to_owned();
    }
    *out += 1;
    let keep = line.len() - after_sep.len();
    let ws_len = after_sep.len() - after_sep.trim_start_matches(['=', ' ', '\t']).len();
    let quote = value_raw.chars().next().filter(|c| *c == '"' || *c == '\'');
    let mut r = String::from(&line[..keep + ws_len]);
    match quote {
        Some(q) => {
            r.push(q);
            r.push_str(REDACTED);
            r.push(q);
        }
        None => r.push_str(REDACTED),
    }
    r
}

impl Redactor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Redact one line (no terminator). Updates `acc` with counts.
    pub fn line(&mut self, line: &str, acc: &mut Redaction) -> String {
        if line.contains(REDACTED) || line.contains(LINE_TRUNCATED.trim()) {
            acc.note("marker-collision", 1);
        }
        if self.in_private_key {
            if line.contains("-----END") && line.contains("PRIVATE KEY") {
                self.in_private_key = false;
            }
            acc.note("private-key-block", 1);
            return REDACTED.to_owned();
        }
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
            if !(line.contains("-----END")
                && line.contains("PRIVATE KEY-----")
                && line.rfind("-----END") > line.find("-----BEGIN"))
            {
                self.in_private_key = true;
            }
            acc.note("private-key-block", 1);
            return REDACTED.to_owned();
        }
        let mut s = line.to_owned();
        let mut n = 0u64;
        for (prefix, tail) in [
            ("sk-ant-", 16usize),
            ("sk-", 20),
            ("ghp_", 20),
            ("gho_", 20),
            ("ghs_", 20),
            ("github_pat_", 20),
            ("glpat-", 16),
            ("xoxb-", 10),
            ("xoxp-", 10),
            ("xoxa-", 10),
            ("AKIA", 16),
            ("ASIA", 16),
            ("AIza", 30),
            ("npm_", 30),
        ] {
            if s.contains(prefix) {
                s = scrub_prefixed(&s, prefix, tail, &mut n);
            }
        }
        if n > 0 {
            acc.note("token", n);
        }
        // JWTs and bearer credentials.
        let mut jn = 0u64;
        let words: Vec<String> = s
            .split(' ')
            .map(|w| {
                let core = w.trim_matches(['"', '\'', ',', ';', ')', '(']);
                if looks_like_jwt(core) {
                    jn += 1;
                    w.replace(core, REDACTED)
                } else {
                    w.to_owned()
                }
            })
            .collect();
        if jn > 0 {
            s = words.join(" ");
            acc.note("jwt", jn);
        }
        let lower = s.to_ascii_lowercase();
        if let Some(i) = lower.find("bearer ") {
            let tail = &s[i + 7..];
            let tok_len: usize = tail
                .chars()
                .take_while(|c| is_tok(*c))
                .map(char::len_utf8)
                .sum();
            if tok_len >= 20 {
                s = [&s[..i + 7], REDACTED, &tail[tok_len..]].concat();
                acc.note("bearer", 1);
            }
        }
        let mut an = 0u64;
        let s2 = scrub_assignment(&s, &mut an);
        if an > 0 {
            acc.note("assignment", an);
        }
        s2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn red(l: &str) -> (String, Redaction) {
        let mut r = Redactor::new();
        let mut a = Redaction::default();
        let o = r.line(l, &mut a);
        (o, a)
    }

    #[test]
    fn redacts_known_shapes() {
        for (l, kind) in [
            ("key = sk-abcdefghijklmnopqrstuvwxyz123456", "token"),
            ("export GH=ghp_abcdefghijklmnopqrstuvwxyz0123", "token"),
            ("aws AKIAABCDEFGHIJKLMNOP end", "token"),
            (
                "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
                "bearer",
            ),
            ("password = \"hunter2hunter2\"", "assignment"),
            (
                "const t = \"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop\";",
                "jwt",
            ),
        ] {
            let (o, a) = red(l);
            assert!(a.redacted, "{l}");
            assert!(a.kinds.contains(&kind.to_owned()), "{l}: {:?}", a.kinds);
            assert!(o.contains(REDACTED), "{o}");
            assert!(!o.contains("hunter2hunter2") && !o.contains("abcdefghijklmnopqrstuvwxyz0"));
        }
    }

    #[test]
    fn leaves_ordinary_code_alone() {
        for l in [
            "fn parse_token(input: &str) -> Token {",
            "let password = read_password(prompt);",
            "const SK = skeleton;",
            "// the task-runner is fine",
            "password = \"\"",
            "password = \"changeme\"",
            "token: ${TOKEN}",
            "let sk = \"sk-\";",
        ] {
            let (o, a) = red(l);
            assert!(!a.redacted, "{l} -> {o}");
            assert_eq!(o, l);
        }
    }

    #[test]
    fn private_key_block_spans_lines() {
        let mut r = Redactor::new();
        let mut a = Redaction::default();
        let lines = [
            "before",
            "-----BEGIN RSA PRIVATE KEY-----",
            "MIIEowIBAAKCAQEA",
            "-----END RSA PRIVATE KEY-----",
            "after",
        ];
        let out: Vec<String> = lines.iter().map(|l| r.line(l, &mut a)).collect();
        assert_eq!(out[0], "before");
        assert_eq!(out[1], REDACTED);
        assert_eq!(out[2], REDACTED);
        assert_eq!(out[3], REDACTED);
        assert_eq!(out[4], "after");
        assert_eq!(a.count, 3);
    }
}
