//! The destination policy of Controlled Internet (M5): which hosts and ports a command may reach through
//! the egress service, and which local development ports it may reach on the user's machine.
//!
//! The policy is part of the user's standing grant: it is chosen through the user-gated path (CLI / Desktop
//! dialog), shown in the consent text, bound into the grant digest that the Kernel seals into the execution,
//! frozen into each task, and only ever NARROWED while a task runs. Nothing a model, a tool argument, a
//! project file or a proxy setting inside the sandbox contains can change it.
//!
//! An allowed hostname is NOT a data-loss-prevention boundary: anything the command can read can be sent to
//! an allowed destination. The policy decides where connections may go, not what they carry.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub const MAX_RULES: usize = 128;
pub const MAX_LOCAL_PORTS: usize = 16;
/// Ports used when a rule names none.
pub const DEFAULT_PORTS: [u16; 2] = [443, 80];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostRule {
    /// A lowercase DNS name (`registry.npmjs.org`) or a wildcard for its subdomains (`*.githubusercontent.com`;
    /// the bare domain is NOT included). Never an IP literal.
    pub host: String,
    pub ports: Vec<u16>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetPolicy {
    pub hosts: Vec<HostRule>,
    /// Ports of services on the USER'S machine (127.0.0.1) that commands may reach, e.g. a dev server.
    #[serde(default)]
    pub local_ports: Vec<u16>,
}

fn is_dns_label(l: &str) -> bool {
    !l.is_empty()
        && l.len() <= 63
        && !l.starts_with('-')
        && !l.ends_with('-')
        && l.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Validate one host pattern; returns the reason when it is refused.
pub fn check_host_pattern(h: &str) -> Result<(), String> {
    let body = h.strip_prefix("*.").unwrap_or(h);
    if body.is_empty() || body.len() > 253 || h.contains(['/', ':', '@', '[', ']', ' ', '\0']) {
        return Err(format!(
            "{h:?} is not a host name (no scheme, port, path or address)"
        ));
    }
    if body.parse::<IpAddr>().is_ok() || body.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return Err(format!("{h:?} is an IP address; allow the host name instead, or a local port for a service on this machine"));
    }
    if body == "localhost"
        || body.ends_with(".localhost")
        || body.ends_with(".local")
        || body.ends_with(".internal")
        || body.ends_with(".lan")
    {
        return Err(format!("{h:?} names this machine or a private network; use a local port rule for a service on this machine"));
    }
    if !body.contains('.') {
        return Err(format!("{h:?} has no domain; write the full host name"));
    }
    // a final label without a letter (or written like a hex number) can be read by old resolvers as an IPv4
    // address ("0x7f.1", "127.1"): never accepted
    let tld = body.rsplit('.').next().unwrap_or("");
    if !tld.bytes().any(|b| b.is_ascii_lowercase()) || tld.starts_with("0x") {
        return Err(format!("{h:?} does not end in a real top-level domain"));
    }
    if !body.split('.').all(is_dns_label) {
        return Err(format!("{h:?} is not a valid lowercase host name"));
    }
    if h.starts_with("*.") && body.split('.').count() < 2 {
        return Err(format!("{h:?} would allow a whole top-level domain"));
    }
    Ok(())
}

impl NetPolicy {
    pub fn is_empty(&self) -> bool {
        self.hosts.is_empty() && self.local_ports.is_empty()
    }

    /// Sorted, de-duplicated, default ports filled in. Equal policies have equal canonical forms.
    pub fn canonical(&self) -> NetPolicy {
        let mut hosts: Vec<HostRule> = Vec::new();
        for r in &self.hosts {
            let mut ports = if r.ports.is_empty() {
                DEFAULT_PORTS.to_vec()
            } else {
                r.ports.clone()
            };
            ports.sort_unstable();
            ports.dedup();
            match hosts.iter_mut().find(|x| x.host == r.host) {
                Some(x) => {
                    x.ports.extend(ports);
                    x.ports.sort_unstable();
                    x.ports.dedup();
                }
                None => hosts.push(HostRule {
                    host: r.host.clone(),
                    ports,
                }),
            }
        }
        hosts.sort_by(|a, b| a.host.cmp(&b.host));
        let mut local = self.local_ports.clone();
        local.sort_unstable();
        local.dedup();
        NetPolicy {
            hosts,
            local_ports: local,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.hosts.len() > MAX_RULES {
            return Err(format!("at most {MAX_RULES} destination rules"));
        }
        if self.local_ports.len() > MAX_LOCAL_PORTS {
            return Err(format!("at most {MAX_LOCAL_PORTS} local ports"));
        }
        for r in &self.hosts {
            check_host_pattern(&r.host)?;
            if r.ports.contains(&0) {
                return Err("port 0 is not a port".into());
            }
            if r.ports.len() > 16 {
                return Err(format!("at most 16 ports for {}", r.host));
            }
        }
        if self.local_ports.contains(&0) {
            return Err("port 0 is not a port".into());
        }
        Ok(())
    }

    pub fn digest(&self) -> String {
        let v = serde_json::to_value(self.canonical()).unwrap_or_default();
        hex::encode(Sha256::digest(
            nexus_contracts::canonical_json(&v).as_bytes(),
        ))
    }

    /// May a connection to `host:port` be made? `host` is the name the client asked for, lowercased.
    pub fn allows(&self, host: &str, port: u16) -> bool {
        let host = host.trim_end_matches('.');
        self.canonical()
            .hosts
            .iter()
            .any(|r| host_matches(&r.host, host) && r.ports.contains(&port))
    }

    pub fn allows_local(&self, port: u16) -> bool {
        self.local_ports.contains(&port)
    }

    /// The stricter of two policies: only what BOTH allow. A wildcard narrowed by an exact rule becomes
    /// the exact rule.
    pub fn intersect(&self, other: &NetPolicy) -> NetPolicy {
        let (a, b) = (self.canonical(), other.canonical());
        let mut hosts: Vec<HostRule> = Vec::new();
        for x in &a.hosts {
            for y in &b.hosts {
                let host = if x.host == y.host {
                    Some(x.host.clone())
                } else if host_matches(&x.host, &y.host) && !y.host.starts_with("*.") {
                    Some(y.host.clone())
                } else if host_matches(&y.host, &x.host) && !x.host.starts_with("*.") {
                    Some(x.host.clone())
                } else if x.host.starts_with("*.") && y.host.starts_with("*.") {
                    // the longer (more specific) wildcard, when one lies inside the other
                    if y.host.ends_with(&x.host[1..]) {
                        Some(y.host.clone())
                    } else if x.host.ends_with(&y.host[1..]) {
                        Some(x.host.clone())
                    } else {
                        None
                    }
                } else {
                    None
                };
                if let Some(host) = host {
                    let ports: Vec<u16> = x
                        .ports
                        .iter()
                        .copied()
                        .filter(|p| y.ports.contains(p))
                        .collect();
                    if !ports.is_empty() {
                        hosts.push(HostRule { host, ports });
                    }
                }
            }
        }
        let local: Vec<u16> = a
            .local_ports
            .iter()
            .copied()
            .filter(|p| b.local_ports.contains(p))
            .collect();
        NetPolicy {
            hosts,
            local_ports: local,
        }
        .canonical()
    }

    /// Does `self` allow everything `other` allows? (`other` is not wider than `self`.)
    pub fn covers(&self, other: &NetPolicy) -> bool {
        self.intersect(other) == other.canonical()
    }
}

/// Does `pattern` (exact or `*.suffix`) match the lowercase host name `host`?
pub fn host_matches(pattern: &str, host: &str) -> bool {
    match pattern.strip_prefix("*.") {
        Some(suffix) => {
            host.len() > suffix.len() + 1
                && host.ends_with(suffix)
                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
        }
        None => pattern == host,
    }
}

/// Named sets of destinations a user can pick instead of typing hosts. They are expanded into explicit rules
/// BEFORE anything is stored or shown: the consent text and the grant always list the real hosts.
pub fn preset(name: &str) -> Option<Vec<HostRule>> {
    let h = |names: &[&str]| -> Vec<HostRule> {
        names
            .iter()
            .map(|n| HostRule {
                host: (*n).to_owned(),
                ports: vec![443],
            })
            .collect()
    };
    Some(match name {
        "npm" | "pnpm" | "yarn" => h(&["registry.npmjs.org", "registry.yarnpkg.com"]),
        "cargo" => h(&["index.crates.io", "static.crates.io", "crates.io"]),
        "pip" | "python" => h(&["pypi.org", "files.pythonhosted.org"]),
        "github" => h(&[
            "github.com",
            "codeload.github.com",
            "api.github.com",
            "raw.githubusercontent.com",
            "objects.githubusercontent.com",
        ]),
        "gitlab" => h(&["gitlab.com"]),
        "go" => h(&["proxy.golang.org", "sum.golang.org"]),
        _ => return None,
    })
}

pub const PRESETS: [&str; 8] = [
    "npm", "pnpm", "yarn", "cargo", "pip", "github", "gitlab", "go",
];

/// Why an address is never connected to on behalf of a host-name rule (loopback, private, link-local and
/// metadata-service ranges, unspecified, multicast, documentation, benchmarking, reserved and every IPv6
/// form that embeds one of those). `None` = a public unicast address.
pub fn forbidden_ip(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(a) => forbidden_v4(a),
        IpAddr::V6(a) => forbidden_v6(a),
    }
}

fn forbidden_v4(a: Ipv4Addr) -> Option<&'static str> {
    let o = a.octets();
    if a.is_unspecified() {
        Some("unspecified address")
    } else if a.is_loopback() {
        Some("loopback address")
    } else if o == [169, 254, 169, 254] || o[0] == 169 && o[1] == 254 {
        Some("link-local / cloud metadata address")
    } else if o[0] == 10
        || (o[0] == 172 && (16..=31).contains(&o[1]))
        || (o[0] == 192 && o[1] == 168)
    {
        Some("private network address")
    } else if o[0] == 100 && (64..=127).contains(&o[1]) {
        Some("carrier-grade NAT address")
    } else if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        Some("IETF protocol assignment")
    } else if (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
    {
        Some("documentation address")
    } else if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        Some("benchmarking address")
    } else if o[0] >= 224 {
        Some("multicast or reserved address")
    } else {
        None
    }
}

fn forbidden_v6(a: Ipv6Addr) -> Option<&'static str> {
    let s = a.segments();
    if a.is_unspecified() {
        return Some("unspecified address");
    }
    if a.is_loopback() {
        return Some("loopback address");
    }
    // IPv4 embedded in IPv6: judge the embedded address
    let o = a.octets();
    let low = Ipv4Addr::new(o[12], o[13], o[14], o[15]);
    let embedded = if (s[..5] == [0, 0, 0, 0, 0] && s[5] == 0xffff)
        || s[..6] == [0, 0, 0, 0, 0, 0]
        || (s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0])
    {
        Some(low) // v4-mapped, v4-compatible, NAT64
    } else if s[0] == 0x2002 {
        Some(Ipv4Addr::new(o[2], o[3], o[4], o[5])) // 6to4
    } else {
        None
    };
    if let Some(v4) = embedded {
        return forbidden_v4(v4);
    }
    if s[0] & 0xff00 == 0xff00 {
        Some("multicast address")
    } else if s[0] & 0xffc0 == 0xfe80 {
        Some("link-local address")
    } else if s[0] & 0xffc0 == 0xfec0 {
        Some("site-local address")
    } else if s[0] & 0xfe00 == 0xfc00 {
        Some("unique-local (private) address")
    } else if s[0] == 0x2001 && s[1] == 0x0db8 {
        Some("documentation address")
    } else if s[0] == 0x2001 && s[1] == 0 {
        Some("Teredo tunnel address")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(hosts: &[(&str, &[u16])], local: &[u16]) -> NetPolicy {
        NetPolicy {
            hosts: hosts
                .iter()
                .map(|(h, ps)| HostRule {
                    host: (*h).into(),
                    ports: ps.to_vec(),
                })
                .collect(),
            local_ports: local.to_vec(),
        }
    }

    #[test]
    fn hosts_match_exactly_or_by_subdomain_wildcard_and_the_apex_is_not_a_wildcard_match() {
        assert!(host_matches("registry.npmjs.org", "registry.npmjs.org"));
        assert!(!host_matches(
            "registry.npmjs.org",
            "evil.registry.npmjs.org"
        ));
        assert!(host_matches(
            "*.githubusercontent.com",
            "raw.githubusercontent.com"
        ));
        assert!(host_matches(
            "*.githubusercontent.com",
            "a.b.githubusercontent.com"
        ));
        assert!(!host_matches(
            "*.githubusercontent.com",
            "githubusercontent.com"
        ));
        assert!(!host_matches(
            "*.githubusercontent.com",
            "xgithubusercontent.com"
        ));
        assert!(!host_matches(
            "*.githubusercontent.com",
            "githubusercontent.com.evil.test"
        ));
    }

    #[test]
    fn rules_apply_to_their_ports_only_and_default_to_https_and_http() {
        let pol = p(
            &[("a.example.com", &[]), ("b.example.com", &[8443])],
            &[3000],
        );
        assert!(pol.allows("a.example.com", 443) && pol.allows("a.example.com", 80));
        assert!(!pol.allows("a.example.com", 22) && !pol.allows("b.example.com", 443));
        assert!(pol.allows("b.example.com", 8443) && pol.allows("a.example.com.", 443));
        assert!(pol.allows_local(3000) && !pol.allows_local(3001));
    }

    #[test]
    fn patterns_that_could_widen_or_name_this_machine_are_refused() {
        for bad in [
            "127.0.0.1",
            "::1",
            "10.0.0.1",
            "localhost",
            "foo.localhost",
            "*.com",
            "http://a.com",
            "a.com:443",
            "a.com/x",
            "user@a.com",
            "UPPER.example.com",
            "a..com",
            "-a.com",
            "*",
            "*.",
            "intranet",
            "x.internal",
            "1.2.3.4",
            "0x7f.1",
            "[::1]",
        ] {
            assert!(check_host_pattern(bad).is_err(), "{bad} must be refused");
        }
        for good in [
            "registry.npmjs.org",
            "*.githubusercontent.com",
            "a-b.example.co.uk",
            "xn--bcher-kva.example",
        ] {
            assert!(check_host_pattern(good).is_ok(), "{good}");
        }
        assert!(p(&[("a.com", &[0])], &[]).validate().is_err());
        assert!(p(&[], &[0]).validate().is_err());
    }

    #[test]
    fn the_digest_ignores_order_and_duplicates_and_changes_with_anything_that_matters() {
        let a = p(
            &[("b.example.com", &[443]), ("a.example.com", &[80, 443])],
            &[3000, 3001],
        );
        let b = p(
            &[
                ("a.example.com", &[443, 80, 80]),
                ("b.example.com", &[443]),
                ("a.example.com", &[]),
            ],
            &[3001, 3000, 3000],
        );
        assert_eq!(a.digest(), b.digest());
        assert_ne!(
            a.digest(),
            p(&[("a.example.com", &[80, 443])], &[3000, 3001]).digest()
        );
        assert_ne!(
            a.digest(),
            p(
                &[("b.example.com", &[443]), ("a.example.com", &[80, 443])],
                &[3000]
            )
            .digest()
        );
    }

    #[test]
    fn narrowing_keeps_only_what_both_policies_allow() {
        let wide = p(
            &[("*.example.com", &[443, 80]), ("x.org", &[443])],
            &[3000, 4000],
        );
        let narrow = p(&[("api.example.com", &[443]), ("y.org", &[443])], &[3000]);
        let i = wide.intersect(&narrow);
        assert_eq!(i, p(&[("api.example.com", &[443])], &[3000]).canonical());
        assert!(wide.covers(&i) && !i.covers(&wide));
        // never wider than either side
        let j = narrow.intersect(&wide);
        assert_eq!(i, j);
        assert!(wide.intersect(&NetPolicy::default()).is_empty());
    }

    #[test]
    fn private_loopback_link_local_metadata_and_embedded_addresses_are_never_public() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "198.51.100.7",
            "203.0.113.9",
            "192.0.2.1",
            "198.18.0.1",
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::7f00:1",
            "2002:7f00:1::1",
            "2001:db8::1",
            "2001::1",
            "fec0::1",
        ] {
            assert!(
                forbidden_ip(ip.parse().unwrap()).is_some(),
                "{ip} must be forbidden"
            );
        }
        for ip in [
            "8.8.8.8",
            "93.184.216.34",
            "140.82.112.3",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert!(
                forbidden_ip(ip.parse().unwrap()).is_none(),
                "{ip} is public"
            );
        }
    }

    #[test]
    fn presets_expand_to_explicit_valid_hosts() {
        for n in PRESETS {
            let hosts = preset(n).unwrap();
            let pol = NetPolicy {
                hosts,
                local_ports: vec![],
            };
            pol.validate().unwrap();
            assert!(!pol.is_empty());
        }
        assert!(preset("everything").is_none());
    }
}
