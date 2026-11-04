//! A5.4 audit: destination policy for A and AAAA answers. The production
//! transport resolves once, classifies EVERY address and refuses the whole
//! destination if any one is not public; these tests pin that behaviour for
//! the OpenCode Go origin shape (dual-stack public host).
use nexus_model::egress::{approve_destination, AddressPolicy, FixedResolver};
use std::net::IpAddr;

fn ips(v: &[&str]) -> FixedResolver {
    FixedResolver(v.iter().map(|s| s.parse::<IpAddr>().unwrap()).collect())
}
fn approve(v: &[&str]) -> bool {
    approve_destination("https://opencode.ai", &ips(v), AddressPolicy::PublicOnly).is_ok()
}

#[test]
fn public_a_and_public_aaaa_answers_are_accepted_and_all_are_pinned() {
    // The real opencode.ai answer shape (4 A + 4 AAAA, Cloudflare).
    let all = [
        "172.65.90.20",
        "172.65.90.21",
        "2606:4700:78::90:0:140",
        "2606:4700:78::90:0:141",
    ];
    let d = approve_destination("https://opencode.ai", &ips(&all), AddressPolicy::PublicOnly)
        .expect("dual-stack public host");
    assert_eq!(
        d.addrs.len(),
        4,
        "every validated address is retained, none invented"
    );
    assert!(approve(&["172.65.90.20"]));
    assert!(approve(&["2606:4700:78::90:0:140"]));
}

#[test]
fn one_restricted_address_poisons_the_whole_answer_in_every_position() {
    let bad = [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.9",
        "172.31.255.1",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "198.18.0.1",
        "192.0.2.1",
        "224.0.0.1",
        "255.255.255.255",
        "240.0.0.1",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "fd12::1",
        "ff02::1",
        "2001:db8::1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::",
        "2001:0:4136:e378:8000:63bf:3fff:fdd2",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "::ffff:169.254.169.254",
        "100::1",
        "3fff::1",
        "2001:2::1",
    ];
    for b in bad {
        assert!(!approve(&[b]), "{b} alone must be refused");
        assert!(!approve(&["172.65.90.20", b]), "public then {b}");
        assert!(!approve(&[b, "172.65.90.20"]), "{b} then public");
        assert!(
            !approve(&["2606:4700:78::90:0:140", "172.65.90.20", b]),
            "dual-stack public plus {b}"
        );
    }
}

#[test]
fn empty_answers_and_obfuscated_literals_are_refused() {
    assert!(!approve(&[]));
    for host in [
        "https://2130706433",
        "https://0x7f.1",
        "https://0177.0.0.1",
        "https://127.1",
        "https://localhost",
        "https://[::1]",
        "https://[::ffff:7f00:1]",
        "https://intranet.corp",
        "https://metadata.internal",
    ] {
        let r = approve_destination(host, &ips(&["172.65.90.20"]), AddressPolicy::PublicOnly);
        assert!(
            r.is_err(),
            "{host} must be refused before resolution is trusted"
        );
    }
}

#[test]
fn production_policy_never_admits_loopback_even_for_https() {
    assert!(approve_destination(
        "https://opencode.ai",
        &ips(&["127.0.0.1"]),
        AddressPolicy::PublicOnly
    )
    .is_err());
}
