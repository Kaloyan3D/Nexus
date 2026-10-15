//! Outbound provider destination policy (A5.1).
//!
//! One pure, dependency-free classifier shared by the Registry-extension
//! validator (`nexus-model`) and the Kernel scope gate (`nexus-kernel`), so
//! both layers refuse the same unsafe destinations: loopback, private,
//! link-local, metadata, multicast, unspecified and CGNAT addresses, local
//! names, and non-canonical numeric host spellings (`2130706433`, `0x7f.1`)
//! that resolvers expand into an address the literal checks would miss.
//!
//! This is a *syntactic* policy over the literal host string. A hostname
//! that later resolves to a private address (DNS rebinding) must be caught
//! by the transport at connect time; the transport used here never
//! resolves names for `https` (no TLS stack) and only connects to literal
//! loopback addresses for test doubles.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Why a host is not an acceptable public provider destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DestinationVerdict {
    /// A syntactically public host (a DNS name or a public IP literal).
    Public,
    /// Loopback address or `localhost` name.
    Loopback,
    /// RFC 1918 / ULA / CGNAT / link-local / metadata / reserved.
    PrivateOrReserved,
    /// Single-label, `.local`, `.internal` and similar local-only names.
    LocalName,
    /// Numeric spelling that is not canonical dotted-quad (obfuscated IP).
    ObfuscatedNumeric,
}

impl DestinationVerdict {
    /// True only for [`DestinationVerdict::Public`].
    pub fn is_public(self) -> bool {
        matches!(self, DestinationVerdict::Public)
    }
}

fn v4_verdict(a: Ipv4Addr) -> DestinationVerdict {
    let o = a.octets();
    if a.is_loopback() {
        return DestinationVerdict::Loopback;
    }
    let reserved = a.is_private()
        || a.is_link_local()
        || a.is_unspecified()
        || a.is_broadcast()
        || a.is_multicast()
        || a.is_documentation()
        || (o[0] == 100 && (o[1] & 0xC0) == 64) // 100.64.0.0/10 CGNAT
        || o[0] == 0
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 198 && (o[1] & 0xFE) == 18) // 198.18.0.0/15 benchmarking
        || o[0] >= 240; // reserved / future
    if reserved {
        DestinationVerdict::PrivateOrReserved
    } else {
        DestinationVerdict::Public
    }
}

/// Classify one resolved address. This is the check that matters for
/// connecting: a name's syntax proves nothing about what it resolves to.
pub fn classify_ip(ip: std::net::IpAddr) -> DestinationVerdict {
    match ip {
        std::net::IpAddr::V4(a) => v4_verdict(a),
        std::net::IpAddr::V6(a) => v6_verdict(a),
    }
}

fn v6_verdict(a: Ipv6Addr) -> DestinationVerdict {
    if a.is_loopback() {
        return DestinationVerdict::Loopback;
    }
    if let Some(v4) = a.to_ipv4_mapped() {
        return v4_verdict(v4);
    }
    let seg = a.segments();
    let reserved = a.is_unspecified()
        || a.is_multicast()
        || (seg[0] & 0xFE00) == 0xFC00 // fc00::/7 unique local
        || (seg[0] & 0xFFC0) == 0xFE80 // fe80::/10 link-local
        || (seg[0] & 0xFFC0) == 0xFEC0 // fec0::/10 deprecated site-local
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
        || (seg[0] == 0 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0 && seg[4] == 0 && seg[5] == 0) // ::/96 compat
        || (seg[0] == 0x0064 && seg[1] == 0xff9b) // 64:ff9b::/96 NAT64
        || seg[0] == 0x2002 // 6to4: embeds an arbitrary IPv4 destination
        || (seg[0] == 0x2001 && seg[1] == 0x0000); // Teredo
    if reserved {
        DestinationVerdict::PrivateOrReserved
    } else {
        DestinationVerdict::Public
    }
}

/// Classify one literal host (no port, no scheme; `[v6]` brackets allowed).
pub fn classify_host(host: &str) -> DestinationVerdict {
    let h = host
        .trim()
        .trim_matches(|c| c == '[' || c == ']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if h.is_empty() {
        return DestinationVerdict::LocalName;
    }
    if let Ok(a) = h.parse::<Ipv6Addr>() {
        return v6_verdict(a);
    }
    if h.contains(':') {
        // Not a valid v6 literal but carries a colon (zone id etc.).
        return DestinationVerdict::ObfuscatedNumeric;
    }
    if let Ok(a) = h.parse::<Ipv4Addr>() {
        return v4_verdict(a);
    }
    if h == "localhost" || h.ends_with(".localhost") {
        return DestinationVerdict::Loopback;
    }
    // All-numeric / hex / dotted-numeric labels that did not parse as a
    // canonical dotted quad are obfuscated IPv4 spellings.
    let numericish = h
        .split('.')
        .all(|l| !l.is_empty() && (l.chars().all(|c| c.is_ascii_digit()) || l.starts_with("0x")));
    if numericish {
        return DestinationVerdict::ObfuscatedNumeric;
    }
    if !h.contains('.') {
        return DestinationVerdict::LocalName;
    }
    const LOCAL_SUFFIXES: [&str; 8] = [
        ".local",
        ".internal",
        ".localdomain",
        ".lan",
        ".home.arpa",
        ".intranet",
        ".corp",
        ".private",
    ];
    if LOCAL_SUFFIXES.iter().any(|s| h.ends_with(s)) {
        return DestinationVerdict::LocalName;
    }
    DestinationVerdict::Public
}

/// Split `scheme://host[:port][/...]` into `(scheme, host)`; `None` when the
/// origin has no scheme, carries userinfo, or has an empty host.
pub fn origin_scheme_host(origin: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = origin.split_once("://")?;
    let hostport = rest.split('/').next().unwrap_or("");
    if hostport.contains('@') || hostport.is_empty() {
        return None;
    }
    let host = if let Some(stripped) = hostport.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        hostport.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme, host))
}

/// True when an origin is an acceptable *public* provider destination:
/// `https` only, host classified [`DestinationVerdict::Public`].
pub fn is_public_https_origin(origin: &str) -> bool {
    matches!(
        origin_scheme_host(origin),
        Some(("https", host)) if classify_host(host).is_public()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_names_and_addresses_pass() {
        for h in [
            "api.openai.com",
            "api.example.co.uk",
            "8.8.8.8",
            "2606:4700::1111",
        ] {
            assert!(classify_host(h).is_public(), "{h}");
        }
    }

    #[test]
    fn private_loopback_and_metadata_are_refused() {
        for h in [
            "127.0.0.1",
            "127.9.9.9",
            "localhost",
            "LOCALHOST.",
            "foo.localhost",
            "10.0.0.5",
            "172.16.4.4",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.1.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "[::1]",
            "fd00::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "metadata",
            "printer.local",
            "svc.internal",
            "2130706433",
            "0x7f.0.0.1",
            "017700000001",
        ] {
            assert!(!classify_host(h).is_public(), "{h} must be refused");
        }
    }

    #[test]
    fn resolved_addresses_are_classified_not_just_names() {
        use std::net::IpAddr;
        let p = |s: &str| classify_ip(s.parse::<IpAddr>().unwrap()).is_public();
        assert!(p("93.184.216.34") && p("2606:4700::1111"));
        for bad in [
            "127.0.0.1",
            "10.0.0.5",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:10.1.1.1",
            "::ffff:169.254.169.254",
            "2002:7f00:1::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "64:ff9b::7f00:1",
        ] {
            assert!(!p(bad), "{bad}");
        }
    }

    #[test]
    fn origin_helpers() {
        assert!(is_public_https_origin("https://api.example.com:443"));
        assert!(!is_public_https_origin("http://api.example.com"));
        assert!(!is_public_https_origin("https://127.0.0.1:8443"));
        assert!(!is_public_https_origin("https://user@api.example.com"));
        assert!(!is_public_https_origin("https://[::1]:443"));
        assert_eq!(
            origin_scheme_host("https://[2606:4700::1111]:443/x"),
            Some(("https", "2606:4700::1111"))
        );
    }
}
