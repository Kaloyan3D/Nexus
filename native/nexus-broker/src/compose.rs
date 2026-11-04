//! Which exit statuses of a shell verification command can be trusted (M4.2 Phase A).
//!
//! The Kernel reports the exit status of the process it started. For `sh -c "<script>"` that is the status of the
//! LAST command the shell ran, so `node --check broken.js; echo done` exits 0 although the check failed, as does
//! `node --check broken.js || true`. A non-zero status is always a real signal; only an exit 0 of a command LIST
//! proves nothing about the members before the last one.
//!
//! This module analyses a script with a real (quote-, heredoc-, substitution-aware) lexer, never string splitting,
//! and says whether an exit 0 attests every check in it:
//!
//! * [`Trust::Attested`]: a single `&&` chain of pipelines (the Kernel applies `pipefail` to pipelines), or a leading
//!   `set -e` followed only by simple `;`-separated commands, or a direct (non-shell) invocation. Exit 0 means every
//!   member succeeded.
//! * [`Trust::Unattested`]: analysable, but a failure could be masked (`;`, newline lists, `||`, a check inside a
//!   command substitution, a status-swallowing wrapper such as `find -exec`).
//! * [`Trust::Unanalyzable`]: control flow, groups, subshells, functions, negation, background jobs, unbalanced quotes:
//!   not analysed, so not trusted. Fail closed.
//!
//! For an unattested script the analysis also names the REQUIRED members (what must be re-established by a command
//! whose exit status IS attested) and, when it can be done without rewriting anything, a derived command made only of
//! those members' original source text joined with `&&`. Nothing here executes anything.

use serde_json::{json, Value};

/// How far an exit 0 can be trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    Attested,
    Unattested,
    Unanalyzable,
}

impl Trust {
    pub fn as_str(self) -> &'static str {
        match self {
            Trust::Attested => "attested",
            Trust::Unattested => "unattested",
            Trust::Unanalyzable => "unanalyzable",
        }
    }
}

/// One pipeline of a script: its stages' words (quotes removed, substitutions kept literal).
pub type Stages = Vec<Vec<String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub stages: Stages,
    /// Original source text of the member (trimmed).
    pub raw: String,
    /// Source text with nested substitutions blanked: the words the shell itself executes at this level.
    pub top: String,
    pub has_heredoc: bool,
    /// Contents of command substitutions / process substitutions in the member.
    pub nested: Vec<String>,
    pub state_changing: bool,
    /// Prints or inspects only (never a check, never needed to reproduce one).
    pub inspector: bool,
    /// M4.7: the member's check-bearing pipeline WITHOUT trailing pure output filters (`cargo build 2>&1 | grep warn`
    /// -> `cargo build`), or the whole pipeline when it has no such tail. This is what a re-establishment must run.
    pub check_stages: Stages,
    /// Source text of `check_stages` (the check stage keeps its own redirects).
    pub check_raw: String,
    /// The pipeline ends in pure output filters after its check stage.
    pub filter_tail: bool,
    /// ... and the last of them SELECTS lines (`grep`, `rg`): its exit 1 means "no line matched", not "the check failed".
    pub selecting_tail: bool,
}

/// The result of analysing one command (`proc_run` arguments).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attestation {
    pub trust: Trust,
    pub reason: &'static str,
    /// Members that must be re-established by an attested command (check-bearing prefix of the script).
    pub required: Vec<Stages>,
    /// A command made of exactly the required members' source text, when it can be derived safely.
    pub derived: Option<Value>,
    /// The members of an ATTESTED command, in order (used to match a later re-establishment).
    pub members: Vec<Stages>,
    /// Nested shells or wrappers were seen at the top level.
    pub notes: Vec<&'static str>,
}

impl Attestation {
    fn attested(reason: &'static str, members: Vec<Stages>) -> Self {
        Self {
            trust: Trust::Attested,
            reason,
            required: Vec::new(),
            derived: None,
            members,
            notes: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Word {
    raw: String,
    value: String,
    /// `raw` with `$(..)`, backticks, `<(..)`, `>(..)` replaced by `$_`.
    top: String,
    /// Contents of nested substitutions (for the lenient scan).
    nested: Vec<String>,
    start: usize,
    end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    And,
    Or,
    Pipe,
    Semi,
    Nl,
    Amp,
    Paren,
}

#[derive(Debug, Clone)]
enum Tok {
    Word(Word),
    Redir {
        start: usize,
        end: usize,
        heredoc: bool,
    },
    Op(Op, #[allow(dead_code)] usize),
}

struct Lexer<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
    toks: Vec<Tok>,
    heredocs: Vec<(String, bool)>,
    lenient: bool,
    fail: Option<&'static str>,
}

fn is_word_end(c: u8) -> bool {
    matches!(
        c,
        b' ' | b'\t' | b'\n' | b'|' | b'&' | b';' | b'(' | b')' | b'<' | b'>'
    )
}

impl<'a> Lexer<'a> {
    fn new(s: &'a str, lenient: bool) -> Self {
        Self {
            s,
            b: s.as_bytes(),
            i: 0,
            toks: Vec::new(),
            heredocs: Vec::new(),
            lenient,
            fail: None,
        }
    }

    fn bad(&mut self, why: &'static str) {
        if self.fail.is_none() {
            self.fail = Some(why);
        }
    }

    /// Index just after the `)` that matches an already-consumed `(`; quotes and nesting aware.
    fn skip_paren(&self, mut i: usize) -> Option<usize> {
        let mut depth = 1i32;
        while i < self.b.len() {
            match self.b[i] {
                b'\\' => i += 1,
                b'\'' => {
                    i += 1;
                    while i < self.b.len() && self.b[i] != b'\'' {
                        i += 1;
                    }
                }
                b'"' => {
                    i += 1;
                    while i < self.b.len() && self.b[i] != b'"' {
                        if self.b[i] == b'\\' {
                            i += 1;
                        }
                        i += 1;
                    }
                }
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    fn skip_to(&self, mut i: usize, close: u8) -> Option<usize> {
        while i < self.b.len() {
            if self.b[i] == b'\\' {
                i += 1;
            } else if self.b[i] == close {
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }

    fn read_word(&mut self) -> Option<Word> {
        let start = self.i;
        let mut value = String::new();
        let mut top = String::new();
        let mut nested: Vec<String> = Vec::new();
        while self.i < self.b.len() {
            let c = self.b[self.i];
            // a process substitution continues a word; any other operator ends it
            if (c == b'<' || c == b'>') && self.b.get(self.i + 1) == Some(&b'(') {
                let open = self.i + 2;
                match self.skip_paren(open) {
                    Some(end) => {
                        nested.push(self.s[open..end - 1].to_owned());
                        value.push_str(&self.s[self.i..end]);
                        top.push_str("$_");
                        self.i = end;
                        continue;
                    }
                    None => {
                        self.bad("unbalanced-substitution");
                        return None;
                    }
                }
            }
            if is_word_end(c) {
                break;
            }
            match c {
                b'\\' => {
                    if self.b.get(self.i + 1) == Some(&b'\n') {
                        self.i += 2;
                        continue;
                    }
                    if let Some(n) = self.s[self.i + 1..].chars().next() {
                        value.push(n);
                        top.push('\\');
                        top.push(n);
                        self.i += 1 + n.len_utf8();
                    } else {
                        self.i += 1;
                    }
                }
                b'\'' => {
                    let Some(end) = self.skip_to_single(self.i + 1) else {
                        self.bad("unterminated-quote");
                        return None;
                    };
                    value.push_str(&self.s[self.i + 1..end - 1]);
                    top.push_str(&self.s[self.i..end]);
                    self.i = end;
                }
                b'"' => {
                    let mut j = self.i + 1;
                    let mut inner = String::new();
                    let mut inner_top = String::from("\"");
                    loop {
                        if j >= self.b.len() {
                            self.bad("unterminated-quote");
                            return None;
                        }
                        match self.b[j] {
                            b'"' => {
                                j += 1;
                                break;
                            }
                            b'\\' => {
                                if let Some(n) = self.s[j + 1..].chars().next() {
                                    if matches!(n, '"' | '\\' | '$' | '`' | '\n') {
                                        if n != '\n' {
                                            inner.push(n);
                                        }
                                    } else {
                                        inner.push('\\');
                                        inner.push(n);
                                    }
                                    inner_top.push('\\');
                                    inner_top.push(n);
                                    j += 1 + n.len_utf8();
                                } else {
                                    j += 1;
                                }
                            }
                            b'$' if self.b.get(j + 1) == Some(&b'(') => {
                                let open = j + 2;
                                match self.skip_paren(open) {
                                    Some(end) => {
                                        nested.push(self.s[open..end - 1].to_owned());
                                        inner.push_str(&self.s[j..end]);
                                        inner_top.push_str("$_");
                                        j = end;
                                    }
                                    None => {
                                        self.bad("unbalanced-substitution");
                                        return None;
                                    }
                                }
                            }
                            b'`' => match self.skip_to(j + 1, b'`') {
                                Some(end) => {
                                    nested.push(self.s[j + 1..end - 1].to_owned());
                                    inner.push_str(&self.s[j..end]);
                                    inner_top.push_str("$_");
                                    j = end;
                                }
                                None => {
                                    self.bad("unterminated-backtick");
                                    return None;
                                }
                            },
                            _ => {
                                let ch = self.s[j..].chars().next().unwrap_or(' ');
                                inner.push(ch);
                                inner_top.push(ch);
                                j += ch.len_utf8();
                            }
                        }
                    }
                    inner_top.push('"');
                    value.push_str(&inner);
                    top.push_str(&inner_top);
                    self.i = j;
                }
                b'$' if self.b.get(self.i + 1) == Some(&b'(') => {
                    let open = self.i + 2;
                    // `$((` arithmetic is balanced the same way
                    match self.skip_paren(open) {
                        Some(end) => {
                            nested.push(self.s[open..end - 1].to_owned());
                            value.push_str(&self.s[self.i..end]);
                            top.push_str("$_");
                            self.i = end;
                        }
                        None => {
                            self.bad("unbalanced-substitution");
                            return None;
                        }
                    }
                }
                b'$' if self.b.get(self.i + 1) == Some(&b'{') => {
                    let Some(end) = self.skip_to(self.i + 2, b'}') else {
                        self.bad("unbalanced-expansion");
                        return None;
                    };
                    value.push_str(&self.s[self.i..end]);
                    top.push_str(&self.s[self.i..end]);
                    self.i = end;
                }
                b'$' if self.b.get(self.i + 1) == Some(&b'\'') => {
                    let mut j = self.i + 2;
                    while j < self.b.len() && self.b[j] != b'\'' {
                        if self.b[j] == b'\\' {
                            j += 1;
                        }
                        j += 1;
                    }
                    if j >= self.b.len() {
                        self.bad("unterminated-quote");
                        return None;
                    }
                    value.push_str(&self.s[self.i + 2..j]);
                    top.push_str(&self.s[self.i..=j]);
                    self.i = j + 1;
                }
                b'`' => match self.skip_to(self.i + 1, b'`') {
                    Some(end) => {
                        nested.push(self.s[self.i + 1..end - 1].to_owned());
                        value.push_str(&self.s[self.i..end]);
                        top.push_str("$_");
                        self.i = end;
                    }
                    None => {
                        self.bad("unterminated-backtick");
                        return None;
                    }
                },
                _ => {
                    let ch = self.s[self.i..].chars().next().unwrap_or(' ');
                    value.push(ch);
                    top.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
        Some(Word {
            raw: self.s[start..self.i].to_owned(),
            value,
            top,
            nested,
            start,
            end: self.i,
        })
    }

    fn skip_to_single(&self, mut i: usize) -> Option<usize> {
        while i < self.b.len() {
            if self.b[i] == b'\'' {
                return Some(i + 1);
            }
            i += 1;
        }
        None
    }

    fn read_redirect(&mut self, start: usize) {
        // operator
        let mut heredoc = false;
        let mut strip = false;
        let c = self.b[self.i];
        self.i += 1;
        if c == b'<' && self.b.get(self.i) == Some(&b'<') {
            self.i += 1;
            if self.b.get(self.i) == Some(&b'<') {
                self.i += 1; // here-string
            } else {
                heredoc = true;
                if self.b.get(self.i) == Some(&b'-') {
                    strip = true;
                    self.i += 1;
                }
            }
        } else if (c == b'>' && matches!(self.b.get(self.i), Some(b'>' | b'|' | b'&')))
            || (c == b'<' && matches!(self.b.get(self.i), Some(b'&' | b'>')))
        {
            // `>>`, `>|`, `>&`, `<&`, `<>`
            self.i += 1;
        }
        while matches!(self.b.get(self.i), Some(b' ' | b'\t')) {
            self.i += 1;
        }
        let Some(target) = self.read_word() else {
            if self.fail.is_none() {
                self.bad("redirect-without-target");
            }
            return;
        };
        if target.raw.is_empty() {
            self.bad("redirect-without-target");
            return;
        }
        if heredoc {
            self.heredocs.push((target.value.clone(), strip));
        }
        self.toks.push(Tok::Redir {
            start,
            end: self.i,
            heredoc,
        });
    }

    fn consume_heredocs(&mut self) {
        let pending = std::mem::take(&mut self.heredocs);
        for (delim, strip) in pending {
            loop {
                if self.i >= self.b.len() {
                    self.bad("unterminated-heredoc");
                    return;
                }
                let line_end = self.s[self.i..]
                    .find('\n')
                    .map_or(self.b.len(), |n| self.i + n);
                let line = &self.s[self.i..line_end];
                let cmp = if strip {
                    line.trim_start_matches('\t')
                } else {
                    line
                };
                self.i = (line_end + 1).min(self.b.len().max(line_end + 1));
                if cmp == delim {
                    break;
                }
                if line_end >= self.b.len() {
                    self.bad("unterminated-heredoc");
                    return;
                }
            }
        }
    }

    fn run(&mut self) {
        while self.i < self.b.len() && (self.fail.is_none() || self.lenient) {
            if self.fail.is_some() {
                break;
            }
            let c = self.b[self.i];
            match c {
                b' ' | b'\t' => self.i += 1,
                b'\n' => {
                    self.toks.push(Tok::Op(Op::Nl, self.i));
                    self.i += 1;
                    if !self.heredocs.is_empty() {
                        self.consume_heredocs();
                    }
                }
                b'#' => {
                    while self.i < self.b.len() && self.b[self.i] != b'\n' {
                        self.i += 1;
                    }
                }
                b'&' => {
                    if self.b.get(self.i + 1) == Some(&b'&') {
                        self.toks.push(Tok::Op(Op::And, self.i));
                        self.i += 2;
                    } else if self.b.get(self.i + 1) == Some(&b'>') {
                        let start = self.i;
                        self.i += 1;
                        self.read_redirect_after_amp(start);
                    } else {
                        self.toks.push(Tok::Op(Op::Amp, self.i));
                        self.i += 1;
                    }
                }
                b'|' => {
                    if self.b.get(self.i + 1) == Some(&b'|') {
                        self.toks.push(Tok::Op(Op::Or, self.i));
                        self.i += 2;
                    } else if self.b.get(self.i + 1) == Some(&b'&') {
                        self.toks.push(Tok::Op(Op::Pipe, self.i));
                        self.i += 2;
                    } else {
                        self.toks.push(Tok::Op(Op::Pipe, self.i));
                        self.i += 1;
                    }
                }
                b';' => {
                    if matches!(self.b.get(self.i + 1), Some(b';' | b'&')) {
                        if self.lenient {
                            self.toks.push(Tok::Op(Op::Semi, self.i));
                            self.i += 2;
                        } else {
                            self.bad("case-terminator");
                        }
                    } else {
                        self.toks.push(Tok::Op(Op::Semi, self.i));
                        self.i += 1;
                    }
                }
                b'(' | b')' => {
                    if self.lenient {
                        self.toks.push(Tok::Op(Op::Paren, self.i));
                        self.i += 1;
                    } else {
                        self.bad("subshell-or-group");
                    }
                }
                b'<' | b'>' => {
                    if self.b.get(self.i + 1) == Some(&b'(') {
                        match self.read_word() {
                            Some(w) => self.toks.push(Tok::Word(w)),
                            None => break,
                        }
                    } else {
                        let start = self.i;
                        self.read_redirect(start);
                    }
                }
                _ => match self.read_word() {
                    Some(w) => {
                        // `2>file`, `1>&2`: a number glued to a redirect operator is a file descriptor
                        if !w.raw.is_empty()
                            && w.raw.bytes().all(|d| d.is_ascii_digit())
                            && matches!(self.b.get(self.i), Some(b'<' | b'>'))
                            && self.b.get(self.i + 1) != Some(&b'(')
                        {
                            let start = w.start;
                            self.read_redirect(start);
                        } else {
                            self.toks.push(Tok::Word(w));
                        }
                    }
                    None => break,
                },
            }
        }
    }

    fn read_redirect_after_amp(&mut self, start: usize) {
        // `&>` / `&>>`: self.i is at `>`
        self.i += 1;
        if self.b.get(self.i) == Some(&b'>') {
            self.i += 1;
        }
        while matches!(self.b.get(self.i), Some(b' ' | b'\t')) {
            self.i += 1;
        }
        if self.read_word().is_some() {
            self.toks.push(Tok::Redir {
                start,
                end: self.i,
                heredoc: false,
            });
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------------

const CONTROL_WORDS: &[&str] = &[
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac",
    "select", "function", "coproc", "{", "}", "[[", "]]", "!", "in",
];

const STATE_CHANGING: &[&str] = &[
    "cd", "pushd", "popd", "export", "set", "unset", "alias", "unalias", "source", ".", "eval",
    "exec", "trap", "umask", "shopt", "ulimit", "read", "declare", "local", "readonly", "typeset",
    "hash", "wait", "shift", "getopts", "return", "exit", "break", "continue",
];

/// Programs whose exit status does not reflect the commands they run.
const SWALLOWING: &[&str] = &["find", "xargs", "eval", "parallel", "watch"];

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sep {
    And,
    Or,
    Semi,
}

struct Pipeline {
    stages: Stages,
    stage_top: Vec<String>,
    /// Source span of each stage (its words and its own redirects).
    stage_spans: Vec<(usize, usize)>,
    /// Whether each stage has a redirect of its own (`> file`, `2>&1`, ...).
    stage_redirect: Vec<bool>,
    nested: Vec<String>,
    has_redirect: bool,
    start: usize,
    end: usize,
    has_heredoc: bool,
}

fn is_assignment(w: &str) -> bool {
    let Some(eq) = w.find('=') else { return false };
    eq > 0
        && w[..eq]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !w[..eq].chars().next().is_some_and(|c| c.is_ascii_digit())
}

fn lex(script: &str, lenient: bool) -> Result<Vec<Tok>, &'static str> {
    let mut lx = Lexer::new(script, lenient);
    lx.run();
    if !lenient {
        if let Some(why) = lx.fail {
            return Err(why);
        }
        if !lx.heredocs.is_empty() {
            return Err("unterminated-heredoc");
        }
    }
    Ok(lx.toks)
}

struct Parsed {
    /// Units in order; `seps[i]` joins unit `i` to unit `i + 1`.
    units: Vec<Vec<Pipeline>>,
    seps: Vec<Sep>,
}

#[allow(unused_assignments)]
fn parse(script: &str) -> Result<Parsed, &'static str> {
    let toks = lex(script, false)?;
    let mut units: Vec<Vec<Pipeline>> = vec![Vec::new()];
    let mut seps: Vec<Sep> = Vec::new();
    let mut stages: Stages = Vec::new();
    let mut stage_top: Vec<String> = Vec::new();
    let mut stage_spans: Vec<(usize, usize)> = Vec::new();
    let mut stage_redirect: Vec<bool> = Vec::new();
    let mut cur_words: Vec<Word> = Vec::new();
    let mut cur_start: Option<usize> = None;
    let mut cur_end = 0usize;
    let mut cur_heredoc = false;
    let mut cur_redirect = false;
    let mut pl_start: Option<usize> = None;
    let mut pl_end = 0usize;
    let mut pl_heredoc = false;
    let mut pl_redirect = false;
    let mut pl_nested: Vec<String> = Vec::new();
    let mut need_command = false; // after && || | : something must follow

    macro_rules! end_stage {
        () => {
            if cur_words.is_empty() && cur_start.is_none() {
                // empty stage
            } else {
                if let Some(first) = cur_words
                    .iter()
                    .find(|w| !is_assignment(&w.value))
                    .or(cur_words.first())
                {
                    if CONTROL_WORDS.contains(&first.value.as_str()) && !cur_words.is_empty() {
                        return Err("control-flow");
                    }
                }
                stages.push(cur_words.iter().map(|w| w.value.clone()).collect());
                stage_top.push(
                    cur_words
                        .iter()
                        .map(|w| w.top.clone())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
                stage_spans.push((cur_start.unwrap_or(0), cur_end));
                stage_redirect.push(cur_redirect);
                pl_start.get_or_insert(cur_start.unwrap_or(0));
                pl_end = cur_end;
                pl_heredoc |= cur_heredoc;
                pl_redirect |= cur_redirect;
                for w in &cur_words {
                    pl_nested.extend(w.nested.iter().cloned());
                }
            }
            cur_words.clear();
            cur_start = None;
            cur_heredoc = false;
            cur_redirect = false;
        };
    }
    macro_rules! end_pipeline {
        () => {
            end_stage!();
            if !stages.is_empty() {
                let p = Pipeline {
                    stages: std::mem::take(&mut stages),
                    stage_top: std::mem::take(&mut stage_top),
                    stage_spans: std::mem::take(&mut stage_spans),
                    stage_redirect: std::mem::take(&mut stage_redirect),
                    nested: std::mem::take(&mut pl_nested),
                    has_redirect: pl_redirect,
                    start: pl_start.take().unwrap_or(0),
                    end: pl_end,
                    has_heredoc: pl_heredoc,
                };
                pl_heredoc = false;
                pl_redirect = false;
                units.last_mut().unwrap().push(p);
                need_command = false;
            }
        };
    }

    for t in toks {
        match t {
            Tok::Word(w) => {
                cur_start.get_or_insert(w.start);
                cur_end = w.end;
                cur_words.push(w);
            }
            Tok::Redir {
                start,
                end,
                heredoc,
            } => {
                cur_start.get_or_insert(start);
                cur_end = end;
                cur_heredoc |= heredoc;
                cur_redirect = true;
            }
            Tok::Op(op, _) => match op {
                Op::Pipe => {
                    if cur_words.is_empty() && cur_start.is_none() {
                        return Err("syntax");
                    }
                    end_stage!();
                    need_command = true;
                }
                Op::And | Op::Or | Op::Semi | Op::Nl | Op::Amp => {
                    let had = !(cur_words.is_empty() && cur_start.is_none()) || !stages.is_empty();
                    if need_command && !had && !matches!(op, Op::Nl) {
                        return Err("syntax");
                    }
                    if matches!(op, Op::Nl) && need_command && !had {
                        continue; // continuation after `&&`/`||`/`|` at a line end
                    }
                    end_pipeline!();
                    let sep = match op {
                        Op::And => Sep::And,
                        Op::Or => Sep::Or,
                        Op::Amp => return Err("background-job"),
                        _ => Sep::Semi,
                    };
                    match sep {
                        Sep::And => {
                            need_command = true;
                            // an && chain continues the same unit
                        }
                        Sep::Or | Sep::Semi => {
                            if !units.last().unwrap().is_empty() {
                                seps.push(sep);
                                units.push(Vec::new());
                            } else if matches!(sep, Sep::Or) {
                                return Err("syntax");
                            }
                            need_command = matches!(sep, Sep::Or);
                        }
                    }
                }
                Op::Paren => return Err("subshell-or-group"),
            },
        }
    }
    end_pipeline!();
    if need_command {
        return Err("syntax");
    }
    while units.last().is_some_and(|u| u.is_empty()) && units.len() > 1 {
        units.pop();
        seps.pop();
    }
    Ok(Parsed { units, seps })
}

/// Commands that only print or read and have no effect a later check could depend on.
const PURE_INSPECTORS: &[&str] = &[
    "ls", "echo", "printf", "cat", "pwd", "true", ":", "test", "[", "date", "whoami", "wc", "head",
    "tail", "stat", "file", "which", "type", "uname", "id", "hostname",
];

/// M4.7: programs that only filter or reshape the text that flows through a pipeline. After a check stage they
/// change nothing the check did; their own exit status is not the check's. `tee` (writes files) and `awk` (can run
/// commands) are deliberately absent; `sed` counts only without in-place editing.
const OUTPUT_FILTERS: &[&str] = &[
    "grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "cat", "sed",
];
/// Filters whose exit 1 means "no line selected".
const SELECTING_FILTERS: &[&str] = &["grep", "egrep", "fgrep", "rg"];

fn stage_program(st: &[String]) -> String {
    let f = st
        .iter()
        .find(|w| !is_assignment(w))
        .cloned()
        .unwrap_or_default();
    f.rsplit('/').next().unwrap_or(&f).to_owned()
}

fn is_output_filter(st: &[String]) -> bool {
    let prog = stage_program(st);
    OUTPUT_FILTERS.contains(&prog.as_str())
        // `sed` edits files with -i/--in-place (also inside a short-flag cluster such as `-Ei`): then it is a writer
        && !(prog == "sed"
            && st.iter().skip(1).any(|w| {
                w.starts_with("--in-place") || (w.starts_with('-') && !w.starts_with("--") && w.contains('i'))
            }))
}

/// (check stages, check source text, filter tail, selecting tail) of one pipeline.
fn check_prefix(script: &str, p: &Pipeline) -> (Stages, String, bool, bool) {
    let whole = (
        p.stages.clone(),
        script[p.start..p.end].trim().to_owned(),
        false,
        false,
    );
    let Some(c) = p.stages.iter().position(|st| is_check(&st.join(" "))) else {
        return whole;
    };
    if c + 1 >= p.stages.len() || p.stage_spans.len() != p.stages.len() {
        return whole;
    }
    let tail_ok = (c + 1..p.stages.len()).all(|i| {
        is_output_filter(&p.stages[i]) && !p.stage_redirect.get(i).copied().unwrap_or(true)
    });
    if !tail_ok {
        return whole;
    }
    let text = script[p.stage_spans[0].0..p.stage_spans[c].1]
        .trim()
        .to_owned();
    let last = stage_program(p.stages.last().unwrap());
    (
        p.stages[..=c].to_vec(),
        text,
        true,
        SELECTING_FILTERS.contains(&last.as_str()),
    )
}

fn member_of(script: &str, p: &Pipeline) -> Member {
    let (check_stages, check_raw, filter_tail, selecting_tail) = check_prefix(script, p);
    let raw = script[p.start..p.end].trim().to_owned();
    let first = p
        .stages
        .first()
        .and_then(|s| s.iter().find(|w| !is_assignment(w)))
        .cloned()
        .unwrap_or_default();
    let pure_assignment = p.stages.len() == 1 && p.stages[0].iter().all(|w| is_assignment(w));
    let state_changing = pure_assignment || STATE_CHANGING.contains(&first.as_str());
    let base = first.rsplit('/').next().unwrap_or(&first).to_owned();
    let inspector = !state_changing
        && !p.has_redirect
        && p.nested.is_empty()
        && p.stages.iter().all(|st| {
            let f = st
                .iter()
                .find(|w| !is_assignment(w))
                .cloned()
                .unwrap_or_default();
            PURE_INSPECTORS.contains(&f.rsplit('/').next().unwrap_or(&f))
        })
        && PURE_INSPECTORS.contains(&base.as_str());
    Member {
        stages: p.stages.clone(),
        raw,
        top: p.stage_top.join(" | "),
        has_heredoc: p.has_heredoc,
        nested: p.nested.clone(),
        state_changing,
        inspector,
        check_stages,
        check_raw,
        filter_tail,
        selecting_tail,
    }
}

fn is_check(raw: &str) -> bool {
    crate::inspect::segment_verifies(raw)
}

/// Does any suffix of the words (after a wrapper program) form a check?
fn wrapped_check(words: &[String]) -> bool {
    (1..words.len()).any(|i| is_check(&words[i..].join(" ")))
}

fn shell_dash_c(words: &[String]) -> Option<String> {
    let prog = words.iter().find(|w| !is_assignment(w))?;
    let base = prog.rsplit('/').next().unwrap_or(prog);
    if !matches!(base, "sh" | "bash" | "dash" | "zsh") {
        return None;
    }
    let i = words.iter().position(|w| w == "-c" || w == "-lc")?;
    words.get(i + 1).cloned()
}

fn norm_cwd(args: &Value) -> String {
    match args.get("cwd").and_then(|c| c.as_str()) {
        None | Some("") | Some("./") | Some(".") => ".".into(),
        Some(c) => c.trim_end_matches('/').to_owned(),
    }
}

/// Lenient flat scan: every check-looking command anywhere in the text, structure ignored (over-approximation).
fn flat_checks(script: &str, depth: u8, out: &mut Vec<Stages>) {
    let mut texts = Vec::new();
    flat_check_texts(script, depth, &mut texts);
    for (st, _) in texts {
        if !out.contains(&st) && out.len() < 16 {
            out.push(st);
        }
    }
}

/// [`flat_checks`] with each check's own source words (quotes kept), for building a plain re-check.
fn flat_check_texts(script: &str, depth: u8, out: &mut Vec<(Stages, String)>) {
    if depth > 4 {
        return;
    }
    let Ok(toks) = lex(script, true) else { return };
    let mut cur: Vec<Word> = Vec::new();
    let flush = |cur: &mut Vec<Word>, out: &mut Vec<(Stages, String)>| {
        while cur
            .first()
            .is_some_and(|w| CONTROL_WORDS.contains(&w.value.as_str()))
        {
            cur.remove(0);
        }
        if cur.is_empty() {
            return;
        }
        let text = cur
            .iter()
            .map(|w| w.raw.clone())
            .collect::<Vec<_>>()
            .join(" ");
        if is_check(&text) {
            let stages = vec![cur.iter().map(|w| w.value.clone()).collect::<Vec<_>>()];
            if !out.iter().any(|(s, _)| *s == stages) && out.len() < 16 {
                out.push((stages, text));
            }
        }
        cur.clear();
    };
    for t in toks {
        match t {
            Tok::Word(w) => {
                for n in &w.nested {
                    flat_check_texts(n, depth + 1, out);
                }
                cur.push(w);
            }
            Tok::Redir { .. } => {}
            Tok::Op(..) => flush(&mut cur, out),
        }
    }
    flush(&mut cur, out);
}

fn analyze_script(script: &str, depth: u8, cwd_args: &Value) -> Attestation {
    let parsed = match parse(script) {
        Ok(p) => p,
        Err(why) => {
            let mut texts = Vec::new();
            flat_check_texts(script, 0, &mut texts);
            return Attestation {
                trust: Trust::Unanalyzable,
                reason: why,
                required: texts.iter().map(|(s, _)| s.clone()).collect(),
                derived: plain_recheck(&texts, cwd_args),
                members: Vec::new(),
                notes: Vec::new(),
            };
        }
    };
    let members: Vec<Vec<Member>> = parsed
        .units
        .iter()
        .map(|u| u.iter().map(|p| member_of(script, p)).collect())
        .collect();
    let mut notes: Vec<&'static str> = Vec::new();
    // a check that the shell does not run at this level (command substitution, nested shell, wrapper)
    let mut degraded: Option<&'static str> = None;
    for m in members.iter().flatten() {
        // a check the shell runs inside a substitution has its status swallowed by the enclosing command
        if m.nested.iter().any(|n| {
            let mut v = Vec::new();
            flat_checks(n, 0, &mut v);
            !v.is_empty()
        }) {
            degraded = Some("check-inside-substitution");
        }
        for st in &m.stages {
            if let Some(inner) = shell_dash_c(st) {
                let mut v = Vec::new();
                flat_checks(&inner, 0, &mut v);
                if depth < 3 && !v.is_empty() {
                    let sub = analyze_script(&inner, depth + 1, cwd_args);
                    if sub.trust != Trust::Attested {
                        degraded = Some("check-inside-nested-shell");
                    }
                    notes.push("nested-shell");
                }
            }
            let first = st
                .iter()
                .find(|w| !is_assignment(w))
                .cloned()
                .unwrap_or_default();
            let base = first.rsplit('/').next().unwrap_or(&first);
            if SWALLOWING.contains(&base) && wrapped_check(st) {
                degraded = Some("status-swallowing-wrapper");
            }
        }
    }
    // M4.7: members are compared by their check form (trailing output filters dropped): under pipefail an attested
    // exit 0 means every stage passed, so `cargo build | tail -5` re-establishes `cargo build` and vice versa
    let flat: Vec<Stages> = members
        .iter()
        .flatten()
        .map(|m| m.check_stages.clone())
        .collect();
    let single_unit = members.len() == 1;
    let errexit = members.first().is_some_and(|u| {
        u.len() == 1
            && u[0].stages.len() == 1
            && u[0].stages[0].first().map(String::as_str) == Some("set")
            && u[0].stages[0].iter().skip(1).all(|w| {
                w == "-e"
                    || w == "-eu"
                    || w == "-ue"
                    || w == "-eo"
                    || w == "pipefail"
                    || w == "-o"
                    || w == "errexit"
                    || w == "-euo"
                    || w == "nounset"
            })
            && u[0].stages[0]
                .iter()
                .any(|w| w.contains('e') || w == "errexit")
    }) && parsed.seps.iter().all(|s| *s == Sep::Semi)
        && members.iter().skip(1).all(|u| u.len() == 1);
    if degraded.is_none() && (single_unit || errexit) {
        let mut a = Attestation::attested(
            if single_unit {
                "and-chain"
            } else {
                "errexit-list"
            },
            flat,
        );
        a.notes = notes;
        return a;
    }
    // unattested: name what has to be re-established
    let last_check_unit = members
        .iter()
        .rposition(|u| u.iter().any(|m| is_check(&m.raw)));
    let reason = degraded.unwrap_or(if parsed.seps.contains(&Sep::Or) {
        "or-list"
    } else {
        "command-list"
    });
    let mut required: Vec<Member> = Vec::new();
    if let Some(last) = last_check_unit {
        for (i, u) in members.iter().enumerate().take(last + 1) {
            // a unit that follows `||` is only a fallback
            let fallback = i > 0 && parsed.seps.get(i - 1) == Some(&Sep::Or);
            if fallback {
                continue;
            }
            for m in u {
                if m.inspector && !is_check(&m.raw) {
                    continue;
                }
                required.push(m.clone());
            }
        }
    }
    let derivable =
        degraded.is_none() && !required.is_empty() && required.iter().all(|m| !m.has_heredoc);
    let derived = derivable.then(|| {
        // M4.7: the check form, so a trailing filter (`| grep warn`) whose exit status is not the check's is not
        // carried into the re-check (it made the M4.6 re-check unsatisfiable on a clean build)
        let text = required
            .iter()
            .map(|m| m.check_raw.clone())
            .collect::<Vec<_>>()
            .join(" && ");
        let mut v = json!({"program": "sh", "args": ["-c", text]});
        let cwd = norm_cwd(cwd_args);
        if cwd != "." {
            v["cwd"] = json!(cwd);
        }
        v
    });
    let mut derived = derived;
    let req_stages: Vec<Stages> = if degraded.is_some() {
        // the shell does not run the check at this level: require the nested checks themselves, and name them as a
        // plain re-check when that can be written without any expansion
        let mut texts = Vec::new();
        flat_check_texts(script, 0, &mut texts);
        derived = plain_recheck(&texts, cwd_args);
        texts.into_iter().map(|(s, _)| s).collect()
    } else {
        required.iter().map(|m| m.check_stages.clone()).collect()
    };
    Attestation {
        trust: Trust::Unattested,
        reason,
        required: req_stages,
        derived,
        members: Vec::new(),
        notes,
    }
}

/// M4.7: a plain `&&` chain of the checks a lenient scan found (loop bodies, substitutions, nested shells), when
/// every one of them is literal text: with a parameter, command substitution, glob or heredoc the words the shell
/// ran are not the words written, and a re-check built from them would not establish the same check.
fn plain_recheck(texts: &[(Stages, String)], cwd_args: &Value) -> Option<Value> {
    if texts.is_empty()
        || texts.iter().any(|(_, t)| {
            t.contains(['$', '`', '*', '?', '[', '{', '~', '\\'])
                || t.contains("<<")
                || t.contains('\n')
        })
    {
        return None;
    }
    let text = texts
        .iter()
        .map(|(_, t)| t.clone())
        .collect::<Vec<_>>()
        .join(" && ");
    let mut v = json!({"program": "sh", "args": ["-c", text]});
    let cwd = norm_cwd(cwd_args);
    if cwd != "." {
        v["cwd"] = json!(cwd);
    }
    Some(v)
}

/// M4.7: a verification command that exited 1 or 2 with pipefail applied, and in which a check pipeline ends in a
/// line-SELECTING filter (`cargo build 2>&1 | grep -i warn`): the status may be the filter's "no line matched", not
/// the check's failure. Such a result proves neither a pass nor a failure. Returns the obligation to re-establish
/// it (the checks in their filter-free form), or `None` when the status is attributable to a check.
///
/// Never a pass: the obligation stays open until an attested command passes the filter-free checks, and if that
/// re-check fails, its failure is recorded as the check's own.
pub fn filter_status(
    args: &Value,
    exit_code: Option<i64>,
    pipefail_applied: bool,
) -> Option<Attestation> {
    if !pipefail_applied || !matches!(exit_code, Some(1) | Some(2)) {
        return None;
    }
    let prog = args.get("program").and_then(|v| v.as_str()).unwrap_or("");
    let base = prog.rsplit('/').next().unwrap_or(prog);
    if !matches!(base, "sh" | "bash" | "dash" | "zsh") {
        return None;
    }
    let argv: Vec<&str> = args
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let i = argv.iter().position(|a| *a == "-c" || *a == "-lc")?;
    let script = *argv.get(i + 1)?;
    let parsed = parse(script).ok()?;
    let members: Vec<Vec<Member>> = parsed
        .units
        .iter()
        .map(|u| u.iter().map(|p| member_of(script, p)).collect())
        .collect();
    // nothing the shell runs at this level may hide a check (a substitution or nested shell is analysed elsewhere)
    if members.iter().flatten().any(|m| !m.nested.is_empty()) {
        return None;
    }
    // the status of a `;`/`||` list is its LAST unit's; of a single `&&` chain, any member's
    let candidates: Vec<&Member> = if members.len() == 1 {
        members[0].iter().collect()
    } else {
        members.last()?.iter().collect()
    };
    if !candidates
        .iter()
        .any(|m| m.selecting_tail && is_check(&m.check_raw))
    {
        return None;
    }
    let mut required: Vec<&Member> = Vec::new();
    for (ui, u) in members.iter().enumerate() {
        if ui > 0 && parsed.seps.get(ui - 1) == Some(&Sep::Or) {
            continue;
        }
        for m in u {
            if m.inspector && !is_check(&m.raw) {
                continue;
            }
            required.push(m);
        }
    }
    if required.iter().any(|m| m.has_heredoc) {
        return None;
    }
    let text = required
        .iter()
        .map(|m| m.check_raw.clone())
        .collect::<Vec<_>>()
        .join(" && ");
    let mut derived = json!({"program": "sh", "args": ["-c", text]});
    let cwd = norm_cwd(args);
    if cwd != "." {
        derived["cwd"] = json!(cwd);
    }
    Some(Attestation {
        trust: Trust::Unattested,
        reason: "filter-status",
        required: required.iter().map(|m| m.check_stages.clone()).collect(),
        derived: Some(derived),
        members: Vec::new(),
        notes: Vec::new(),
    })
}

/// Analyse the `proc_run` arguments of ONE command.
pub fn analyze(args: &Value) -> Attestation {
    let prog = args.get("program").and_then(|v| v.as_str()).unwrap_or("");
    let argv: Vec<String> = args
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let base = prog.rsplit('/').next().unwrap_or(prog);
    if matches!(base, "sh" | "bash" | "dash" | "zsh") {
        if let Some(i) = argv.iter().position(|a| a == "-c" || a == "-lc") {
            if let Some(script) = argv.get(i + 1) {
                return analyze_script(script, 0, args);
            }
        }
    }
    // a direct invocation: the Kernel's status is the program's own
    let mut words = vec![prog.to_owned()];
    words.extend(argv);
    Attestation::attested("direct", vec![vec![words]])
}

/// Does an ATTESTED command re-establish every required member, in order, in the same working directory?
pub fn satisfies(
    required: &[Stages],
    required_cwd: &str,
    candidate: &Attestation,
    candidate_args: &Value,
) -> bool {
    if candidate.trust != Trust::Attested || norm_cwd(candidate_args) != required_cwd {
        return false;
    }
    if required.is_empty() {
        // nothing could be named: any attested verification pass stands in (documented limitation)
        return true;
    }
    let mut it = candidate.members.iter();
    required.iter().all(|r| it.any(|m| m == r))
}

pub fn cwd_of(args: &Value) -> String {
    norm_cwd(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Value {
        json!({"program": "sh", "args": ["-c", script]})
    }
    fn t(script: &str) -> (Trust, &'static str) {
        let a = analyze(&sh(script));
        (a.trust, a.reason)
    }

    #[test]
    fn the_three_masked_shapes_are_unattested() {
        assert_eq!(t("node --check broken.js; echo done").0, Trust::Unattested);
        assert_eq!(
            t("node --check broken.js || true"),
            (Trust::Unattested, "or-list")
        );
        assert_eq!(
            t("node --check broken.js && echo ok; echo end").0,
            Trust::Unattested
        );
        assert_eq!(t("node --check broken.js\necho done").0, Trust::Unattested);
    }

    #[test]
    fn plain_chains_pipelines_and_direct_commands_are_attested() {
        assert_eq!(t("node --check a.js").0, Trust::Attested);
        assert_eq!(
            t("node --check a.js && node --check b.js && echo ok").0,
            Trust::Attested
        );
        assert_eq!(t("cargo test 2>&1 | tail -20").0, Trust::Attested);
        assert_eq!(
            t("python3 extract.py && node --check /tmp/x.js && echo JS_OK").0,
            Trust::Attested
        );
        assert_eq!(
            analyze(&json!({"program": "node", "args": ["--check", "a.js"]})).trust,
            Trust::Attested
        );
        assert_eq!(
            t("set -e; node --check a.js; node --check b.js").0,
            Trust::Attested
        );
        assert_eq!(
            t("set -eu\nnode --check a.js\nnode --check b.js").0,
            Trust::Attested
        );
        // `set -e` does not cover `||` or `&&` lists
        assert_eq!(t("set -e; node --check a.js || true").0, Trust::Unattested);
        assert_eq!(
            t("set -e; node --check a.js && echo ok; echo end").0,
            Trust::Unattested
        );
    }

    #[test]
    fn quoting_never_creates_or_hides_a_separator() {
        // separators inside quotes, heredoc bodies, substitutions and comments are data
        assert_eq!(t(r#"node --check "a;b.js""#).0, Trust::Attested);
        assert_eq!(t("node --check 'a && b; c || d.js'").0, Trust::Attested);
        assert_eq!(
            t("python3 - <<'PY' && node --check x.js\nprint(1); print(2)\nPY").0,
            Trust::Attested
        );
        assert_eq!(t("node --check x.js # ; echo hidden").0, Trust::Attested);
        assert_eq!(
            t(r#"node --check "$(echo a; echo b).js""#).0,
            Trust::Attested
        );
        assert_eq!(t(r"node --check a\;b.js").0, Trust::Attested);
        // a real separator after quoted text is still a separator
        assert_eq!(
            t(r#"node --check "a;b.js"; echo done"#).0,
            Trust::Unattested
        );
    }

    #[test]
    fn a_check_the_shell_does_not_run_at_the_top_level_is_not_attested() {
        assert_eq!(
            t("echo $(node --check broken.js)"),
            (Trust::Unattested, "check-inside-substitution")
        );
        assert_eq!(
            t("echo `node --check broken.js`").1,
            "check-inside-substitution"
        );
        assert_eq!(
            t("find . -name '*.js' -exec node --check {} \\;").1,
            "status-swallowing-wrapper"
        );
        assert_eq!(
            t("xargs -n1 node --check < files").1,
            "status-swallowing-wrapper"
        );
        assert_eq!(
            t("sh -c 'node --check a.js; echo ok'").1,
            "check-inside-nested-shell"
        );
        assert_eq!(t("sh -c 'node --check a.js && echo ok'").0, Trust::Attested);
    }

    #[test]
    fn control_flow_groups_negation_background_and_bad_syntax_fail_closed() {
        for s in [
            "if node --check a.js; then echo ok; fi",
            "for f in *.js; do node --check $f; done",
            "while true; do node --check a.js; done",
            "case x in x) node --check a.js;; esac",
            "(node --check a.js; true)",
            "{ node --check a.js; true; }",
            "f() { node --check a.js; }; f",
            "! node --check a.js",
            "node --check a.js &",
            "node --check 'a.js",
            "node --check \"a.js",
            "node --check a.js &&",
            "node --check $(echo a",
            "cat <<EOF\nnever closed",
            "[[ -f a.js ]] && node --check a.js",
        ] {
            assert_eq!(analyze(&sh(s)).trust, Trust::Unanalyzable, "{s}");
        }
    }

    #[test]
    fn the_required_members_exclude_inspectors_and_masking_tails() {
        let a = analyze(&sh("ls -la; node --check broken.js; echo done"));
        assert_eq!(a.trust, Trust::Unattested);
        assert_eq!(
            a.required,
            vec![vec![vec![
                "node".to_owned(),
                "--check".into(),
                "broken.js".into()
            ]]]
        );
        assert_eq!(
            a.derived.as_ref().unwrap()["args"][1],
            "node --check broken.js"
        );
        // a fallback after || is not required
        let a = analyze(&sh("node --check broken.js || echo failed"));
        assert_eq!(a.required.len(), 1);
        assert_eq!(
            a.derived.as_ref().unwrap()["args"][1],
            "node --check broken.js"
        );
    }

    #[test]
    fn the_live_accepted_run_shape_derives_its_own_check_unit_verbatim() {
        let s = r#"python3 extract.py && node --check /tmp/hiiii-check.js && echo JS_OK; python3 -c "from html.parser import HTMLParser; p=HTMLParser(); p.feed(open('index.html').read()); print('check ok')""#;
        let a = analyze(&sh(s));
        assert_eq!(a.trust, Trust::Unattested);
        let d = a.derived.as_ref().expect("derived").clone();
        let text = d["args"][1].as_str().unwrap();
        assert!(
            text.starts_with("python3 extract.py && node --check /tmp/hiiii-check.js"),
            "{text}"
        );
        assert!(!text.contains("echo JS_OK"));
        // the derived command is itself attested and satisfies the requirement
        let da = analyze(&d);
        assert_eq!(da.trust, Trust::Attested);
        assert!(satisfies(&a.required, &cwd_of(&sh(s)), &da, &d));
    }

    #[test]
    fn state_changing_prefixes_are_part_of_the_requirement() {
        let a = analyze(&sh("cd sub; node --check x.js; echo done"));
        assert_eq!(a.trust, Trust::Unattested);
        assert_eq!(
            a.derived.as_ref().unwrap()["args"][1],
            "cd sub && node --check x.js"
        );
        let b = analyze(&sh("cp new.js a.js; node --check a.js; echo done"));
        assert_eq!(
            b.derived.as_ref().unwrap()["args"][1],
            "cp new.js a.js && node --check a.js"
        );
    }

    #[test]
    fn a_later_check_must_match_member_for_member_and_cwd() {
        let a = analyze(&sh("node --check broken.js; echo done"));
        let cwd = cwd_of(&sh("x"));
        let plain = json!({"program": "node", "args": ["--check", "broken.js"]});
        assert!(satisfies(&a.required, &cwd, &analyze(&plain), &plain));
        let chain = sh("node --check broken.js && echo ok");
        assert!(satisfies(&a.required, &cwd, &analyze(&chain), &chain));
        // a different file, a different check, a masked repeat, or another directory do not
        for other in [
            json!({"program": "node", "args": ["--check", "other.js"]}),
            json!({"program": "node", "args": ["--test"]}),
            sh("node --check broken.js; echo again"),
            json!({"program": "node", "args": ["--check", "broken.js"], "cwd": "sub"}),
        ] {
            assert!(
                !satisfies(&a.required, &cwd, &analyze(&other), &other),
                "{other}"
            );
        }
    }

    #[test]
    fn heredoc_members_have_no_derived_command_but_keep_their_requirement() {
        let a = analyze(&sh("python3 - <<'PY'\nprint('check')\nPY\necho done"));
        assert_eq!(a.trust, Trust::Unattested);
        assert!(a.derived.is_none());
    }

    #[test]
    fn unanalyzable_scripts_still_name_the_checks_they_contain() {
        let a = analyze(&sh(
            "if [ -f package.json ]; then npm ci; npm test; fi; echo done",
        ));
        assert_eq!(a.trust, Trust::Unanalyzable);
        assert!(
            a.required
                .iter()
                .any(|s| s[0] == vec!["npm".to_owned(), "test".into()]),
            "{:?}",
            a.required
        );
        // M4.7: the plain re-check the guard names is exactly the checks found, and the controller accepts it
        let d = a
            .derived
            .clone()
            .expect("a literal check gets a plain re-check");
        assert_eq!(d, json!({"program": "sh", "args": ["-c", "npm test"]}));
        assert!(satisfies(&a.required, ".", &analyze(&d), &d));
        // a check whose words are expansions gets none: no written command is provably the same check
        let e = analyze(&sh("for f in a.js b.js; do node --check $f; done"));
        assert_eq!(e.trust, Trust::Unanalyzable);
        assert!(e.derived.is_none());
        // nested substitution contents are scanned too
        let b = analyze(&sh("if true; then x=$(node --check a.js); fi"));
        assert!(
            b.required.iter().any(|s| s[0][0] == "node"),
            "{:?}",
            b.required
        );
    }

    #[test]
    fn analysis_is_total_and_never_panics_on_odd_input() {
        for s in [
            "",
            " ",
            "\n\n",
            ";",
            "&&",
            "|",
            "<",
            ">",
            "a >",
            "a <<",
            "$(",
            "'",
            "\"",
            "`",
            "a 2>&1 | ",
            "echo é; node --check ü.js",
            "\\",
            "a;;b",
            "a & b",
        ] {
            let _ = analyze(&sh(s));
        }
    }

    /// REPLAY of every verification command recorded in the live runs (exact argv from the Kernel's approval
    /// records), old rule versus new. Every difference is intentional and listed here; the historical receipts
    /// themselves are not touched (the old verdicts stay in the fixture as `legacyActivityVerification`).
    #[test]
    fn replay_of_the_recorded_commands_changes_exactly_the_intended_outcomes() {
        let corpus: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/recorded_checks.json")).unwrap();
        assert_eq!(corpus.len(), 12);
        // (run, call) -> expected new assessment of an exit-0 pass: "kept" or "unverified"
        let mut changed: Vec<(String, u64, &'static str)> = Vec::new();
        for c in &corpus {
            let args = json!({"program": c["program"], "args": c["args"]});
            let legacy_is_check = crate::inspect::is_verification_command(&args);
            let kernel_pass = c["kernelVerdict"] == "pass";
            let att = analyze(&args);
            let new = if legacy_is_check && kernel_pass && att.trust != Trust::Attested {
                "unverified"
            } else {
                "kept"
            };
            // a non-zero status is never touched
            if !kernel_pass {
                assert_eq!(new, "kept", "{c}");
            }
            if new == "unverified" {
                changed.push((
                    c["run"].as_str().unwrap().to_owned(),
                    c["call"].as_u64().unwrap(),
                    "unverified",
                ));
            }
            // commands that were never checks are not affected either way
            if !legacy_is_check {
                assert_eq!(new, "kept", "{c}");
            }
        }
        // The exact set of intentional differences (exit 0 of a command LIST or control flow credited as a pass):
        //   live-1 #7  `ls -la; echo; if [ -f package.json ]; then … npm test …; elif …`: control flow; nothing
        //              ran (no package.json), yet it was credited as a passing check;
        //   live-4 #18 `python3 extract.py && node --check … && echo JS_OK; python3 -c "…"`: the accepted run's
        //              first check, followed by a `;` list.
        // Unchanged on purpose: live-2 #12, live-3 #29 and live-4 #19 are plain `&&` chains (attested), every
        // non-zero status (live-3 #28/#30) and every command that is not a check.
        let got: Vec<String> = changed.iter().map(|(r, c, _)| format!("{r}#{c}")).collect();
        println!("REPLAY changed: {got:?}");
        let want = ["live-1#7", "live-4-accepted-run#18"];
        assert_eq!(got, want, "unexpected differences: {got:?}");

        // live-4 #18: the derived command exists, is itself attested, and re-establishes the hazard; the run's own
        // later chain (#19) uses a DIFFERENT producer, so it does not (fail closed: one extra command is needed)
        let by = |run: &str, call: u64| {
            let c = corpus
                .iter()
                .find(|c| c["run"] == run && c["call"] == call)
                .unwrap();
            json!({"program": c["program"], "args": c["args"]})
        };
        let h18 = by("live-4-accepted-run", 18);
        let a18 = analyze(&h18);
        let derived = a18
            .derived
            .clone()
            .expect("a derived command exists for live-4 #18");
        let da = analyze(&derived);
        assert_eq!(da.trust, Trust::Attested);
        assert!(satisfies(&a18.required, &cwd_of(&h18), &da, &derived));
        let h19 = by("live-4-accepted-run", 19);
        let a19 = analyze(&h19);
        assert_eq!(a19.trust, Trust::Attested);
        assert!(!satisfies(&a18.required, &cwd_of(&h18), &a19, &h19));
        // live-1 #7 is control flow: no derived command, the check it names is `npm test`
        let h7 = by("live-1", 7);
        let a7 = analyze(&h7);
        assert_eq!(a7.trust, Trust::Unanalyzable);
        // M4.7: control flow now gets the plain re-check of the literal checks it names, and it is satisfiable
        let d7 = a7.derived.clone().expect("plain re-check for live-1 #7");
        assert!(satisfies(&a7.required, &cwd_of(&h7), &analyze(&d7), &d7));
        assert!(
            a7.required
                .iter()
                .any(|s| s[0][..2] == ["npm".to_owned(), "test".to_owned()]),
            "{:?}",
            a7.required
        );
    }

    // ---- M4.7: check pipelines with trailing output filters --------------------------------------------------

    fn fs(script: &str, exit: i64) -> Option<Attestation> {
        filter_status(&sh(script), Some(exit), true)
    }

    /// The five masked shapes stay unattested: nothing in M4.7 changes how `;`, newline, `||` or a fallback is trusted.
    #[test]
    fn m47_masked_shapes_stay_unattested() {
        for (script, reason) in [
            ("cargo test; echo done", "command-list"),
            ("cargo test || true", "or-list"),
            ("cargo test && echo ok; echo end", "command-list"),
            ("cargo test | grep pattern || true", "or-list"),
            ("cargo test 2>&1 | tail -5; echo done", "command-list"),
        ] {
            let a = analyze(&sh(script));
            assert_eq!((a.trust, a.reason), (Trust::Unattested, reason), "{script}");
            // the re-check is the check itself, never the masking tail and never the filter
            let d = a.derived.clone().expect(script);
            let text = d["args"][1].as_str().unwrap();
            assert!(text.starts_with("cargo test"), "{script} -> {text}");
            assert!(
                !text.contains("echo") && !text.contains("true") && !text.contains('|'),
                "{script} -> {text}"
            );
            let da = analyze(&d);
            assert_eq!(da.trust, Trust::Attested);
            assert!(satisfies(&a.required, ".", &da, &d), "{script}");
            // and the masking shape itself never satisfies its own obligation
            assert!(!satisfies(&a.required, ".", &a, &sh(script)), "{script}");
        }
    }

    /// Exit 1/2 of a check piped into a SELECTING filter is ambiguous; every other status keeps its meaning.
    #[test]
    fn m47_filter_status_is_ambiguous_only_where_the_filter_could_have_produced_it() {
        // the benchmark shape: a clean build makes grep exit 1
        let a = fs(
            "touch src/lib.rs src/main.rs && cargo build 2>&1 | grep -i 'warn'",
            1,
        )
        .unwrap();
        assert_eq!(a.reason, "filter-status");
        assert_eq!(
            a.derived.unwrap()["args"][1],
            "touch src/lib.rs src/main.rs && cargo build 2>&1"
        );
        // a status grep cannot produce is the check's own failure
        assert!(fs("cargo test 2>&1 | grep FAILED", 101).is_none());
        // without pipefail the status is the filter's and proves nothing either way: the Kernel already says so
        assert!(filter_status(&sh("cargo build | grep warn"), Some(1), false).is_none());
        // a non-selecting tail (tail/head/wc) exits 0: an exit 1 there is the check's
        assert!(fs("cargo build 2>&1 | tail -5", 1).is_none());
        // a check NOT followed by a selecting filter
        assert!(fs("cargo build", 1).is_none());
        assert!(fs("grep -q ready log.txt", 1).is_none());
        // a `;` list: only the LAST unit's status is the script's
        assert!(fs("cargo build | grep warn; cargo test", 1).is_none());
        let l = fs("npm test; cargo build 2>&1 | grep -c warning", 1).unwrap();
        assert_eq!(
            l.derived.unwrap()["args"][1],
            "npm test && cargo build 2>&1"
        );
        // `tee` writes a file and `awk` can run commands: never treated as pure filters
        assert!(fs("cargo build 2>&1 | tee build.log | grep warn", 1).is_none());
        assert!(fs("cargo build 2>&1 | awk '/warn/'", 1).is_none());
        // in-place sed is a writer
        assert!(analyze(&sh("cargo build | sed -i s/a/b/ f; echo x")).required[0].len() == 2);
        // a direct (non-shell) invocation has no pipeline
        assert!(filter_status(
            &json!({"program": "cargo", "args": ["build"]}),
            Some(1),
            true
        )
        .is_none());
    }

    /// Re-establishment compares check forms: an attested pass with or without a trailing filter satisfies the same
    /// check; a different producer, check or directory still does not.
    #[test]
    fn m47_check_forms_match_across_trailing_filters_only() {
        let h = analyze(&sh("cargo build 2>&1 | grep -i warn; ls"));
        assert_eq!(h.trust, Trust::Unattested);
        for ok in [
            "cargo build",
            "cargo build 2>&1 | tail -5",
            "cargo build 2>&1",
        ] {
            let c = sh(ok);
            assert!(satisfies(&h.required, ".", &analyze(&c), &c), "{ok}");
        }
        let direct = json!({"program": "cargo", "args": ["build"]});
        assert!(satisfies(&h.required, ".", &analyze(&direct), &direct));
        for no in [
            "cargo build --release",
            "cargo test",
            "cargo build | tee x.log",
        ] {
            let c = sh(no);
            assert!(!satisfies(&h.required, ".", &analyze(&c), &c), "{no}");
        }
        let elsewhere = json!({"program": "sh", "args": ["-c", "cargo build"], "cwd": "sub"});
        assert!(!satisfies(
            &h.required,
            ".",
            &analyze(&elsewhere),
            &elsewhere
        ));
    }

    /// SATISFIABILITY INVARIANT over every recorded command (the M4.2 corpus and the M4.7 benchmark run): whenever
    /// the analysis names a re-check, that re-check is attested and a pass of it resolves the obligation.
    #[test]
    fn m47_every_named_recheck_is_satisfiable() {
        let mut corpus: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/recorded_checks.json")).unwrap();
        let run: Value =
            serde_json::from_str(include_str!("../tests/fixtures/replay_run_faf5.json")).unwrap();
        for s in run["steps"].as_array().unwrap() {
            if s["tool"] == "proc_run" {
                corpus.push(json!({"program": s["args"]["program"], "args": s["args"]["args"], "exitCode": s["output"]["exitCode"]}));
            }
        }
        let mut named = 0;
        for c in &corpus {
            let args = json!({"program": c["program"], "args": c["args"]});
            let mut obligations = vec![analyze(&args)];
            if let Some(f) = filter_status(&args, c["exitCode"].as_i64(), true) {
                obligations.push(f);
            }
            for a in obligations {
                if a.trust == Trust::Attested {
                    continue;
                }
                if let Some(d) = &a.derived {
                    named += 1;
                    let da = analyze(d);
                    assert_eq!(da.trust, Trust::Attested, "{args} -> {d}");
                    assert!(
                        satisfies(&a.required, &cwd_of(&args), &da, d),
                        "{args} -> {d}"
                    );
                }
            }
        }
        println!(
            "M4.7 satisfiability: {named} named re-checks over {} recorded commands",
            corpus.len()
        );
        assert!(named >= 6);
    }
}
