//! Credential redaction that never hides that it happened: every replacement
//! is a visible `[REDACTED:<kind>]` marker and the count is returned.

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '+' | '=')
}

/// Prefixes that identify a secret by shape, with the minimum token length.
const PREFIXES: &[(&str, &str, usize)] = &[
    ("sk-", "api-key", 8),
    ("sk_", "api-key", 8),
    ("rk_", "api-key", 8),
    ("ghs_", "github-token", 16),
    ("ghu_", "github-token", 16),
    ("glpat-", "gitlab-token", 12),
    ("npm_", "npm-token", 16),
    ("hf_", "hf-token", 16),
    ("ghp_", "github-token", 16),
    ("gho_", "github-token", 16),
    ("github_pat_", "github-token", 16),
    ("xoxb-", "slack-token", 10),
    ("xoxp-", "slack-token", 10),
    ("AKIA", "aws-access-key", 12),
    ("AIza", "google-api-key", 20),
    ("eyJ", "jwt", 24),
];

const ASSIGN_KEYS: &[&str] = &[
    "api_key",
    "api-key",
    "apikey",
    "secret",
    "password",
    "passwd",
    "token",
    "authorization",
    "access_key",
    "client_secret",
    "private_key",
    "cookie",
    "credential",
];

/// Replace credential-like spans. Returns the sanitized text and the number
/// of replacements.
pub fn redact_text(raw: &str) -> (String, u32) {
    let mut out = String::with_capacity(raw.len());
    let mut count = 0u32;
    let chars: Vec<(usize, char)> = raw.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let (byte_i, c) = chars[i];
        let rest = &raw[byte_i..];

        // PEM private key blocks.
        if rest.starts_with("-----BEGIN")
            && rest
                .char_indices()
                .nth(60)
                .map(|(i, _)| &rest[..i])
                .unwrap_or(rest)
                .contains("PRIVATE KEY")
        {
            let end = rest.find("-----END").map(|e| {
                rest[e..]
                    .find("-----\n")
                    .map(|x| e + x + 6)
                    .unwrap_or(rest.len())
            });
            out.push_str("[REDACTED:private-key]");
            count += 1;
            let skip_to = byte_i + end.unwrap_or(rest.len());
            while i < chars.len() && chars[i].0 < skip_to {
                i += 1;
            }
            continue;
        }

        // scheme://user:password@host
        if let Some(tail) = rest.strip_prefix("://") {
            let end = tail
                .find(|c: char| c == '/' || c.is_whitespace() || c == '@')
                .unwrap_or(tail.len());
            if tail[end..].starts_with('@') && tail[..end].contains(':') {
                out.push_str("://[REDACTED:url-credentials]");
                count += 1;
                let skip_to = byte_i + 3 + end; // keep the '@'
                while i < chars.len() && chars[i].0 < skip_to {
                    i += 1;
                }
                continue;
            }
        }

        // Authorization: Bearer <token>
        let lower: String = rest.chars().take(7).collect::<String>().to_lowercase();
        if lower == "bearer " {
            out.push_str(&rest[..7]); // ASCII-only match, so 7 bytes is a boundary
            let mut j = i + 7;
            let start = j;
            while j < chars.len() && is_token_char(chars[j].1) {
                j += 1;
            }
            if j > start {
                out.push_str("[REDACTED:bearer-token]");
                count += 1;
                i = j;
                continue;
            }
            i += 7;
            continue;
        }

        // key=value / "key": "value" assignments.
        let mut matched_assign = false;
        for key in ASSIGN_KEYS {
            if rest
                .get(..key.len())
                .is_some_and(|h| h.eq_ignore_ascii_case(key))
            {
                // must start at a word boundary
                let prev_ok = i == 0 || !chars[i - 1].1.is_ascii_alphanumeric();
                if !prev_ok {
                    continue;
                }
                let mut j = i + key.chars().count();
                while j < chars.len() && matches!(chars[j].1, '"' | '\'') {
                    j += 1;
                }
                let mut k = j;
                while k < chars.len() && chars[k].1 == ' ' {
                    k += 1;
                }
                if k < chars.len() && matches!(chars[k].1, '=' | ':') {
                    k += 1;
                    while k < chars.len() && matches!(chars[k].1, ' ' | '"' | '\'') {
                        k += 1;
                    }
                    let quote = if k > 0 && matches!(chars[k - 1].1, '"' | '\'') {
                        Some(chars[k - 1].1)
                    } else {
                        None
                    };
                    let vstart = k;
                    // `Authorization: Bearer <token>`: let the bearer rule take
                    // the token instead of consuming only the scheme word.
                    let scheme: String = chars[vstart..]
                        .iter()
                        .take(7)
                        .map(|(_, c)| c.to_ascii_lowercase())
                        .collect();
                    if scheme == "bearer " {
                        continue;
                    }
                    if let Some(q) = quote {
                        // quoted value: take up to the closing quote (bounded)
                        while k < chars.len() && chars[k].1 != q && k - vstart < 512 {
                            k += 1;
                        }
                    } else {
                        while k < chars.len() && is_token_char(chars[k].1) {
                            k += 1;
                        }
                    }
                    if k - vstart >= 6 {
                        out.push_str(&raw[byte_i..chars[vstart].0]);
                        out.push_str("[REDACTED:credential]");
                        count += 1;
                        i = k;
                        matched_assign = true;
                        break;
                    }
                }
            }
        }
        if matched_assign {
            continue;
        }

        // Shape-identified tokens.
        let mut matched = false;
        let at_boundary = i == 0 || !is_token_char(chars[i - 1].1);
        if at_boundary {
            for (prefix, kind, min_len) in PREFIXES {
                if rest.starts_with(prefix) {
                    let mut j = i;
                    while j < chars.len() && is_token_char(chars[j].1) {
                        j += 1;
                    }
                    if j - i >= *min_len {
                        out.push_str(&format!("[REDACTED:{kind}]"));
                        count += 1;
                        i = j;
                        matched = true;
                    }
                    break;
                }
            }
        }
        if matched {
            continue;
        }
        out.push(c);
        i += 1;
    }
    (out, count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_and_reports() {
        let (s, n) = redact_text("use sk-test-SECRET-marker-xyz and Bearer abc123def456 ok");
        assert!(!s.contains("SECRET") && !s.contains("abc123def456"));
        assert!(s.contains("[REDACTED:api-key]") && s.contains("[REDACTED:bearer-token]"));
        assert_eq!(n, 2);
    }

    #[test]
    fn assignments_and_pem() {
        let (s, n) = redact_text("{\"password\": \"hunter2hunter2\"} api_key=abcdef123456 -----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\nafter");
        assert!(!s.contains("hunter2") && !s.contains("abcdef123456") && !s.contains("MIIB"));
        assert!(s.contains("after"));
        assert!(n >= 3, "{s} {n}");
    }

    #[test]
    fn authorization_header_redacts_the_token_not_the_scheme() {
        let (s, n) = redact_text("Authorization: Bearer abcdefghij123456 end");
        assert!(!s.contains("abcdefghij123456"), "{s}");
        assert!(s.contains("Bearer [REDACTED:bearer-token]"), "{s}");
        assert_eq!(n, 1);
    }

    #[test]
    fn quoted_values_url_credentials_and_more_prefixes() {
        let (s, n) = redact_text(
            "password: \"correct horse battery staple\" url=https://bob:hunter22@example.com/x token ghs_abcdefghijklmnopqrstuv sk_live_abcdefghijkl",
        );
        for leak in ["correct horse", "hunter22", "ghs_abcdef", "sk_live_abc"] {
            assert!(!s.contains(leak), "{leak} leaked: {s}");
        }
        assert!(s.contains("@example.com/x"));
        assert!(n >= 4, "{s}");
    }

    #[test]
    fn plain_text_is_untouched() {
        let t = "The token budget is large; skip tasks. Привет — sk is short.";
        let (s, n) = redact_text(t);
        assert_eq!(s, t);
        assert_eq!(n, 0);
    }

    #[test]
    fn unicode_is_preserved() {
        let (s, _) = redact_text("Здравей, свят — secret=zzzzzzzz1234 край");
        assert!(s.starts_with("Здравей, свят — "));
        assert!(s.ends_with("край"));
    }
}
