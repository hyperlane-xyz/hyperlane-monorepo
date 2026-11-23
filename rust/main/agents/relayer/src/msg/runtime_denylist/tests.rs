use std::{io::Write, str::FromStr};

use chrono::{DateTime, Utc};
use hyperlane_core::{HyperlaneMessage, H160, H256};
use serde_json::json;
use tempfile::NamedTempFile;

use super::*;

const EVM_ADDRESS: &str = "0xA97bF7836F8A08F9Ed91D41453D371493FAE8d10";
const TRON_ADDRESS: &str = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_ADDRESS_HEX: &str = "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c";
const SOLANA_ADDRESS: &str = "4UMNyNWW75zo69hxoJaRX5iXNUa5FdRPZZa9vDVCiESg";

fn now() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-02T00:00:00Z")
        .expect("valid timestamp")
        .with_timezone(&Utc)
}

fn evm(address: &str) -> H256 {
    H160::from_str(address).expect("valid address").into()
}

fn file(rules: serde_json::Value) -> Vec<u8> {
    serde_json::to_vec(&json!({ "rules": rules })).expect("serializable")
}

fn message_rule(id: H256) -> serde_json::Value {
    json!({ "reason": "stuck", "addedBy": "paul", "match": { "messageId": format!("{id:?}") } })
}

fn address_rule(address: &str) -> serde_json::Value {
    json!({ "reason": "exploit", "addedBy": "paul", "address": address })
}

fn parse(rules: serde_json::Value) -> Result<ActiveRules> {
    parse_rules(&file(rules), now())
}

fn denylist_with(rules: serde_json::Value) -> RuntimeDenylist {
    let denylist = RuntimeDenylist::default();
    denylist.replace(parse(rules).expect("valid rules"), true);
    denylist
}

fn message(sender: H256, recipient: H256, body: Vec<u8>) -> HyperlaneMessage {
    HyperlaneMessage {
        sender,
        recipient,
        body,
        ..Default::default()
    }
}

fn warp_body(recipient: H256) -> Vec<u8> {
    let mut body = recipient.as_bytes().to_vec();
    body.extend_from_slice(&[0u8; 32]);
    body
}

#[test]
fn parses_message_and_address_rules() {
    let rules = parse(json!([
        message_rule(H256::random()),
        address_rule(EVM_ADDRESS)
    ]))
    .expect("valid rules");
    assert_eq!(rules.messages.len(), 1);
    assert_eq!(rules.addresses.len(), 1);
    assert_eq!(rules.addresses[0].address, evm(EVM_ADDRESS));
    assert_eq!(rules.messages[0].reason, "stuck (added by paul)");
}

#[test]
fn opt_in_body_matching_preserves_nested_ica_payout_coverage_and_removal() {
    use ethers::abi::{encode, Token};

    use crate::msg::blacklist::AddressBlacklist;

    let listed = evm(EVM_ADDRESS);
    let alice = evm("0x1111111111111111111111111111111111111111");
    let mut transfer = hex::decode("a9059cbb").expect("selector");
    transfer.extend_from_slice(listed.as_bytes());
    transfer.extend_from_slice(H256::from_low_u64_be(1_000_000).as_bytes());
    let calls = Token::Array(vec![Token::Tuple(vec![
        Token::FixedBytes(
            evm("0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1")
                .as_bytes()
                .to_vec(),
        ),
        Token::Uint(0u64.into()),
        Token::Bytes(transfer),
    ])]);
    // ICA CALLS | owner | ISM | salt | ABI calls.
    let mut body = vec![0];
    body.extend_from_slice(alice.as_bytes());
    body.extend_from_slice(H256::zero().as_bytes());
    body.extend_from_slice(H256::zero().as_bytes());
    body.extend_from_slice(&encode(&[calls]));
    let mut msg = HyperlaneMessage {
        origin: 1,
        destination: 42161,
        sender: evm("0xD61F078592CeD81449a7405d837Ff1B963b830EA"),
        recipient: evm("0xa0F62E4a4597471AA6FaC829aCA3c468EA751C3C"),
        body,
        ..Default::default()
    };
    assert_eq!(msg.body.len(), 417);
    assert_eq!(
        msg.body
            .windows(20)
            .position(|bytes| bytes == &listed.as_bytes()[12..]),
        Some(337)
    );
    let old = AddressBlacklist::new(vec![listed.as_bytes()[12..].to_vec()]);
    assert!(old.find_blacklisted_address(&msg).is_some());

    let address_only = json!([address_rule(EVM_ADDRESS)]);
    let denylist = denylist_with(address_only.clone());
    assert!(denylist.deny_reason_for_message(&msg).is_none());
    let body_rule = json!({ "reason": "exploit", "addedBy": "paul", "address": EVM_ADDRESS, "matchBody": true });
    denylist.set_rules_for_test(json!([body_rule]));
    assert!(denylist.deny_reason_for_message(&msg).is_some());
    msg.origin = 2;
    assert!(denylist.deny_reason_for_message(&msg).is_some());
    denylist.set_rules_for_test(json!([]));
    assert!(denylist.deny_reason_for_message(&msg).is_none());
}

#[test]
fn match_accepts_case_insensitive_keys() {
    let msg = message(H256::random(), H256::random(), vec![]);
    for key in ["messageId", "messageid", "MESSAGEID", "MeSsAgEiD"] {
        let denylist = denylist_with(json!([
            { "reason": "r", "addedBy": "a", "match": { key: format!("{:?}", msg.id()) } }
        ]));
        assert!(denylist.deny_reason_for_message(&msg).is_some(), "{key}");
    }
}

#[test]
fn body_matching_is_byte_aligned_opt_in_and_expires_with_its_address_rule() {
    let listed = evm(EVM_ADDRESS);
    let mut body = vec![0xab; 337];
    body.extend_from_slice(&listed.as_bytes()[12..]);
    let mut msg = message(H256::random(), H256::random(), body);
    for match_body in [false, true] {
        let denylist = denylist_with(json!([{
            "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "matchBody": match_body
        }]));
        assert_eq!(denylist.deny_reason_for_message(&msg).is_some(), match_body);
    }
    let denylist = denylist_with(json!([{
        "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "matchBody": true
    }]));
    msg.body = hex::decode(format!("0{}0", hex::encode(&listed.as_bytes()[12..])))
        .expect("nibble-shifted hex");
    assert!(denylist.deny_reason_for_message(&msg).is_none());

    msg.body = listed.as_bytes()[12..].to_vec();
    let expires_at = Utc::now() + chrono::Duration::hours(1);
    denylist.set_rules_for_test(json!([{
        "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "matchBody": true,
        "expiresAt": expires_at.to_rfc3339()
    }]));
    assert!(denylist.deny_reason_for_message(&msg).is_some());
    let expired_rules = denylist
        .rules
        .read()
        .without_expired(expires_at)
        .expect("expired rule");
    denylist.replace(expired_rules, false);
    assert!(denylist.deny_reason_for_message(&msg).is_none());
    assert_eq!(denylist.summary().address_rules, 0);
}

#[test]
fn body_matching_keeps_all_twenty_bytes_at_any_offset() {
    for address in [EVM_ADDRESS, "0x00000000000000000000000235aE95896583818d"] {
        let denylist = denylist_with(json!([{
            "reason": "r", "addedBy": "a", "address": address, "matchBody": true
        }]));
        let bytes = hex::decode(&address[2..]).expect("EVM bytes");
        for offset in [0, 1, 31, 32, 337, 512] {
            let mut body = vec![0xab; offset];
            body.extend_from_slice(&bytes);
            let msg = message(H256::random(), H256::random(), body);
            assert!(denylist.deny_reason_for_message(&msg).is_some());
        }
        let short = message(H256::random(), H256::random(), bytes[1..].to_vec());
        assert!(denylist.deny_reason_for_message(&short).is_none());
    }
}

#[test]
fn mixed_case_match_keys_preserve_constraints_and_regex_case() {
    let msg = message(evm(EVM_ADDRESS), H256::random(), vec![0xab]);
    let denylist = denylist_with(json!([
        { "reason": "r", "addedBy": "a", "match": {
            "MeSsAgEiD": format!("{:?}", msg.id()),
            "ORIGINDOMAIN": msg.origin,
            "SenderAddress": EVM_ADDRESS,
            "DestinationDomain": msg.destination,
            "RECIPIENTADDRESS": format!("{:?}", msg.recipient),
            "BodyRegex": "^a\\D$"
        } }
    ]));
    assert!(denylist.deny_reason_for_message(&msg).is_some());
    assert!(denylist
        .deny_reason_for_message(&message(evm(EVM_ADDRESS), H256::random(), vec![0xab]))
        .is_none());
}

#[test]
fn identical_match_aliases_are_harmless() {
    let msg = message(H256::random(), H256::random(), vec![]);
    let id = format!("{:?}", msg.id());
    let denylist = denylist_with(json!([
        { "reason": "r", "addedBy": "a", "match": { "messageId": id, "MESSAGEID": id } }
    ]));
    assert!(denylist.deny_reason_for_message(&msg).is_some());
}

#[test]
fn conflicting_match_aliases_are_rejected() {
    for match_ in [
        json!({ "originDomain": 1, "ORIGINDOMAIN": "*" }),
        json!({ "originDomain": "*", "ORIGINDOMAIN": 1 }),
        json!({ "originDomain": 1, "bodyRegex": "\\D", "BODYREGEX": "\\d" }),
    ] {
        let error = parse(json!([
            { "reason": "r", "addedBy": "a", "match": match_ }
        ]))
        .expect_err("conflicting aliases must reject");
        assert!(format!("{error:#}").contains("Conflicting `match` aliases"));
    }
}

#[test]
fn skips_expired_rules_but_validates_them() {
    let expired = json!({ "reason": "r", "addedBy": "a", "expiresAt": "2026-11-01T00:00:00Z", "address": EVM_ADDRESS });
    let active = json!({ "reason": "r", "addedBy": "a", "expiresAt": "2026-11-03T00:00:00Z", "address": EVM_ADDRESS });
    let rules = parse(json!([expired, active])).expect("valid rules");
    assert_eq!(rules.addresses.len(), 1);
    assert_eq!(rules.fingerprint.len(), 1);

    let invalid_expired = json!({ "reason": "r", "addedBy": "a", "expiresAt": "2026-11-01T00:00:00Z", "address": "nope" });
    assert!(parse(json!([invalid_expired])).is_err());
}

#[test]
fn rejects_invalid_rules() {
    let cases = [
        // Would block every message.
        json!({ "reason": "r", "addedBy": "a", "match": {} }),
        json!({ "reason": "r", "addedBy": "a", "match": { "originDomain": "*", "messageId": "*" } }),
        // `bodyRegex` alone, or a null field, still leaves every exact field a wildcard.
        json!({ "reason": "r", "addedBy": "a", "match": { "bodyRegex": "" } }),
        json!({ "reason": "r", "addedBy": "a", "match": { "bodyRegex": ".*" } }),
        json!({ "reason": "r", "addedBy": "a", "match": { "messageId": null } }),
        // An empty list matches nothing, so the rule would silently do nothing.
        json!({ "reason": "r", "addedBy": "a", "match": { "messageId": [] } }),
        json!({ "reason": "r", "addedBy": "a", "match": { "originDomain": 1, "senderAddress": [] } }),
        // A Tron address with a one-character typo fails its checksum.
        json!({ "reason": "r", "addedBy": "a", "address": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u" }),
        json!({ "reason": "r", "addedBy": "a", "address": "0x0000000000000000000000000000000000000000" }),
        json!({ "reason": "r", "addedBy": "a", "address": "" }),
        // Typo would otherwise become a wildcard.
        json!({ "reason": "r", "addedBy": "a", "match": { "messageID_": "0x01" } }),
        json!({ "reason": "r", "addedBy": "a", "address": "not-an-address" }),
        json!({ "reason": "", "addedBy": "a", "address": EVM_ADDRESS }),
        json!({ "reason": "r", "addedBy": " ", "address": EVM_ADDRESS }),
        json!({ "reason": "r", "address": EVM_ADDRESS }),
        json!({ "reason": "r", "addedBy": "a" }),
        json!({ "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "match": { "originDomain": 1 } }),
        json!({ "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "unknown": 1 }),
        json!({ "reason": "r", "addedBy": "a", "match": { "originDomain": 1 }, "matchBody": false }),
        json!({ "reason": "r", "addedBy": "a", "address": SOLANA_ADDRESS, "matchBody": true }),
        json!({ "reason": "r", "addedBy": "a", "address": TRON_ADDRESS, "matchBody": true }),
        json!({ "reason": "r", "addedBy": "a", "address": format!("{:?}", evm(EVM_ADDRESS)), "matchBody": true }),
        json!({ "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "matchBody": "true" }),
        json!({ "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "matchBody": null }),
        json!({ "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "expiresAt": "tomorrow" }),
    ];
    for case in cases {
        assert!(parse(json!([case.clone()])).is_err(), "accepted {case}");
    }
    assert!(parse_rules(br#"{"rules": [], "extra": 1}"#, now()).is_err());
    assert!(parse_rules(b"not json", now()).is_err());
}

#[test]
fn fingerprint_ignores_rule_order() {
    let a = message_rule(H256::random());
    let b = address_rule(EVM_ADDRESS);
    let first = parse(json!([a.clone(), b.clone()])).expect("valid");
    let second = parse(json!([b, a])).expect("valid");
    assert_eq!(first.fingerprint, second.fingerprint);
}

#[test]
fn denies_by_message_id() {
    let msg = message(H256::random(), H256::random(), vec![1, 2, 3]);
    let denylist = denylist_with(json!([message_rule(msg.id())]));
    assert_eq!(
        denylist.deny_reason_for_message(&msg).as_deref(),
        Some("stuck (added by paul)")
    );
    let other = message(H256::random(), H256::random(), vec![1, 2, 3]);
    assert_eq!(denylist.deny_reason_for_message(&other), None);
}

#[test]
fn denies_address_as_sender_recipient_or_warp_recipient() {
    let denylist = denylist_with(json!([address_rule(EVM_ADDRESS)]));
    let blocked = evm(EVM_ADDRESS);
    let cases = [
        message(blocked, H256::random(), vec![]),
        message(H256::random(), blocked, vec![]),
        message(H256::random(), H256::random(), warp_body(blocked)),
    ];
    for msg in cases {
        assert!(denylist.deny_reason_for_message(&msg).is_some());
    }
}

#[test]
fn address_match_is_exact_not_substring() {
    let denylist = denylist_with(json!([address_rule(EVM_ADDRESS)]));
    let blocked = evm(EVM_ADDRESS);
    // Address bytes appear in the body, but not as the warp recipient word.
    let mut body = vec![0u8; 7];
    body.extend_from_slice(blocked.as_bytes());
    let msg = message(H256::random(), H256::random(), body);
    assert_eq!(denylist.deny_reason_for_message(&msg), None);
}

#[test]
fn accepts_solana_and_tron_addresses() {
    let denylist = denylist_with(json!([
        address_rule(SOLANA_ADDRESS),
        address_rule(TRON_ADDRESS)
    ]));
    let solana = hyperlane_core::utils::hex_or_base58_or_bech32_to_h256(SOLANA_ADDRESS)
        .expect("valid address");
    let tron = evm(TRON_ADDRESS_HEX);
    for recipient in [solana, tron] {
        let msg = message(H256::random(), H256::random(), warp_body(recipient));
        assert!(denylist.deny_reason_for_message(&msg).is_some());
    }
}

#[test]
fn replace_bumps_version_only_on_change() {
    let denylist = RuntimeDenylist::default();
    assert_eq!(denylist.version(), 0);
    let rules = json!([address_rule(EVM_ADDRESS)]);
    denylist.replace(parse(rules.clone()).expect("valid"), true);
    assert_eq!(denylist.version(), 1);
    denylist.replace(parse(rules).expect("valid"), true);
    assert_eq!(denylist.version(), 1);
    denylist.replace(parse(json!([])).expect("valid"), true);
    assert_eq!(denylist.version(), 2);
}

fn file_denylist(file: &NamedTempFile) -> RuntimeDenylist {
    let cache_path = file.path().with_extension("cache.json");
    denylist_at(
        Url::from_file_path(file.path()).expect("absolute path"),
        cache_path,
    )
}

fn denylist_at(url: Url, cache_path: std::path::PathBuf) -> RuntimeDenylist {
    RuntimeDenylist::new(
        Some(RuntimeDenylistConf {
            url,
            poll_interval: Duration::from_secs(1),
            cache_path,
        }),
        RuntimeDenylistMetrics::new(
            &CoreMetrics::new("test", 9090, prometheus::Registry::new()).expect("metrics"),
        )
        .expect("metrics"),
    )
    .expect("denylist")
}

fn write(file: &mut NamedTempFile, contents: &[u8]) {
    let f = file.as_file_mut();
    f.set_len(0).expect("truncate");
    f.write_all(contents).expect("write");
    f.flush().expect("flush");
    std::io::Seek::rewind(f).expect("rewind");
}

#[tokio::test]
async fn refresh_from_file_keeps_previous_rules_on_bad_file() {
    let mut tmp = NamedTempFile::new().expect("tempfile");
    write(&mut tmp, &file(json!([address_rule(EVM_ADDRESS)])));
    let denylist = file_denylist(&tmp);

    let summary = denylist.refresh().await.expect("refresh");
    assert_eq!(summary.address_rules, 1);
    assert_eq!(summary.version, 1);

    write(&mut tmp, b"{ broken");
    assert!(denylist.refresh().await.is_err());
    let blocked = message(H256::random(), evm(EVM_ADDRESS), vec![]);
    assert!(denylist.deny_reason_for_message(&blocked).is_some());

    let cache_path = &denylist
        .source
        .as_ref()
        .expect("configured source")
        .cache_path;
    let cached = tokio::fs::read(cache_path).await.expect("cached rules");
    write(
        &mut tmp,
        &file(json!([
            { "reason": "r", "addedBy": "a", "match": { "originDomain": 1, "ORIGINDOMAIN": "*" } }
        ])),
    );
    assert!(denylist.refresh().await.is_err());
    assert_eq!(denylist.version(), 1);
    assert!(denylist.deny_reason_for_message(&blocked).is_some());
    assert_eq!(
        tokio::fs::read(cache_path).await.expect("cached rules"),
        cached
    );

    write(&mut tmp, &file(json!([])));
    let summary = denylist.refresh().await.expect("refresh");
    assert_eq!(summary.address_rules, 0);
    assert_eq!(summary.version, 2);
    assert_eq!(denylist.deny_reason_for_message(&blocked), None);
}

#[tokio::test]
async fn startup_falls_back_to_cached_file_when_fetch_fails() {
    let dir = tempfile::tempdir().expect("tempdir");
    let source = dir.path().join("denylist.json");
    let cache = dir.path().join("cache.json");
    let msg = message(H256::random(), H256::random(), vec![]);
    std::fs::write(
        &source,
        file(json!([
            { "reason": "r", "addedBy": "a", "address": EVM_ADDRESS, "matchBody": true },
            { "reason": "r", "addedBy": "a", "match": { "MESSAGEID": format!("{:?}", msg.id()) } }
        ])),
    )
    .expect("write");

    let first = denylist_at(Url::from_file_path(&source).expect("url"), cache.clone());
    first.initial_load().await.expect("initial policy");
    assert!(first
        .source
        .as_ref()
        .expect("configured source")
        .cache_path
        .exists());

    std::fs::remove_file(&source).expect("remove");
    let restarted = denylist_at(Url::from_file_path(&source).expect("url"), cache);
    restarted.initial_load().await.expect("cached policy");
    assert_eq!(restarted.summary().address_rules, 1);
    assert_eq!(restarted.summary().message_rules, 1);
    assert!(restarted.deny_reason_for_message(&msg).is_some());
    let body_only = message(
        H256::random(),
        H256::random(),
        evm(EVM_ADDRESS).as_bytes()[12..].to_vec(),
    );
    assert!(restarted.deny_reason_for_message(&body_only).is_some());
}

#[test]
fn without_expired_drops_only_expired_rules() {
    let rules = parse(json!([
        { "reason": "r", "addedBy": "a", "expiresAt": "2026-11-03T00:00:00Z", "address": EVM_ADDRESS },
        message_rule(H256::random()),
    ]))
    .expect("valid");
    assert!(rules.without_expired(now()).is_none());
    let later = DateTime::parse_from_rfc3339("2026-11-04T00:00:00Z")
        .expect("valid timestamp")
        .with_timezone(&Utc);
    let pruned = rules.without_expired(later).expect("one rule expired");
    assert_eq!((pruned.messages.len(), pruned.addresses.len()), (1, 0));
    assert_eq!(pruned.fingerprint.len(), 1);
}

#[tokio::test]
async fn prune_expired_applies_without_a_fetch() {
    let soon = (Utc::now() + chrono::Duration::milliseconds(300)).to_rfc3339();
    let denylist = denylist_with(json!([
        { "reason": "r", "addedBy": "a", "expiresAt": soon, "address": EVM_ADDRESS }
    ]));
    let version = denylist.version();
    tokio::time::sleep(Duration::from_millis(400)).await;
    denylist.prune_expired().await;
    assert_eq!(denylist.summary().address_rules, 0);
    assert_eq!(denylist.version(), version + 1);
}

#[tokio::test]
async fn startup_without_fetch_or_valid_cache_fails() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = Url::from_file_path(dir.path().join("missing.json")).expect("url");
    let cache = dir.path().join("cache.json");
    for invalid_cache in [false, true] {
        let denylist = denylist_at(missing.clone(), cache.clone());
        if invalid_cache {
            std::fs::write(
                &denylist
                    .source
                    .as_ref()
                    .expect("configured source")
                    .cache_path,
                b"not json",
            )
            .expect("write invalid cache");
        }
        let error = denylist
            .initial_load()
            .await
            .expect_err("must fail startup");
        assert!(format!("{error:#}").contains("refusing to start without a policy"));
        assert_eq!(denylist.version(), 0);
    }
}

#[tokio::test]
async fn startup_rejects_cache_from_a_different_feed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let first_source = dir.path().join("mainnet.json");
    let other_source = dir.path().join("testnet.json");
    let cache = dir.path().join("cache.json");
    std::fs::write(&first_source, file(json!([address_rule(EVM_ADDRESS)]))).expect("write feed");
    let first = denylist_at(
        Url::from_file_path(&first_source).expect("url"),
        cache.clone(),
    );
    first.initial_load().await.expect("initial policy");

    let other = denylist_at(Url::from_file_path(&other_source).expect("url"), cache);
    assert_ne!(
        first.source.as_ref().expect("first source").cache_path,
        other.source.as_ref().expect("other source").cache_path,
    );
    let error = other
        .initial_load()
        .await
        .expect_err("another feed's cache must not authorize startup");
    assert!(format!("{error:#}").contains("refusing to start without a policy"));
    assert_eq!(other.summary().address_rules, 0);
    assert_eq!(other.version(), 0);
}

#[tokio::test]
async fn startup_rejects_legacy_unbound_cache() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = Url::from_file_path(dir.path().join("missing.json")).expect("url");
    let cache = dir.path().join("cache.json");
    // Older files carry no evidence of which URL wrote the rules.
    std::fs::write(&cache, file(json!([address_rule(EVM_ADDRESS)]))).expect("write legacy cache");
    let denylist = denylist_at(missing, cache);
    let error = denylist
        .initial_load()
        .await
        .expect_err("unbound cache must not authorize startup");
    assert!(format!("{error:#}").contains("refusing to start without a policy"));
    assert_eq!(denylist.version(), 0);
}

#[tokio::test]
async fn startup_without_runtime_source_does_not_require_a_policy() {
    RuntimeDenylist::default()
        .initial_load()
        .await
        .expect("runtime denylist disabled");
}

#[tokio::test]
async fn fetch_caps_file_size() {
    let client = reqwest::Client::new();
    let mut tmp = NamedTempFile::new().expect("tempfile");
    let url = Url::from_file_path(tmp.path()).expect("url");

    tmp.as_file_mut()
        .set_len(MAX_FILE_BYTES as u64)
        .expect("resize file");
    assert_eq!(
        fetch(&client, &url).await.expect("at the limit").len(),
        MAX_FILE_BYTES
    );

    tmp.as_file_mut()
        .set_len(MAX_FILE_BYTES as u64 + 1)
        .expect("resize file");
    let err = fetch(&client, &url).await.expect_err("over the limit");
    assert!(err.to_string().contains("is at least"), "{err}");
}

/// `/dev/zero` reports a length of 0 and never ends, so only a capped read
/// returns (a metadata check passes, then an uncapped read never finishes).
#[cfg(unix)]
#[tokio::test]
async fn fetch_caps_files_that_misreport_their_size() {
    let url = Url::from_file_path("/dev/zero").expect("url");
    let err = tokio::time::timeout(
        Duration::from_secs(10),
        fetch(&reqwest::Client::new(), &url),
    )
    .await
    .expect("capped read returns")
    .expect_err("over the limit");
    assert!(err.to_string().contains("is at least"), "{err}");
}

#[test]
fn tron_addresses_need_the_0x41_prefix_and_checksum() {
    // A valid base58check string with the wrong version byte.
    let wrong_prefix = bs58::encode([0x42u8; 21]).with_check().into_string();
    for address in [wrong_prefix.as_str(), "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"] {
        assert!(parse(json!([address_rule(address)])).is_err(), "{address}");
        // Also inside a match rule's sender or recipient.
        let rule =
            json!({ "reason": "r", "addedBy": "a", "match": { "senderAddress": [address] } });
        assert!(parse(json!([rule])).is_err(), "{address}");
    }
    let rule =
        json!({ "reason": "r", "addedBy": "a", "match": { "recipientAddress": TRON_ADDRESS } });
    assert!(parse(json!([rule])).is_ok());
}

/// Serve one raw HTTP response and return its URL.
async fn serve_once(head: String, body: Vec<Vec<u8>>) -> Url {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let url = Url::parse(&format!(
        "http://{}/denylist.json",
        listener.local_addr().expect("addr")
    ))
    .expect("url");
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.expect("accept");
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request).await;
        let _ = stream.write_all(head.as_bytes()).await;
        for part in body {
            if stream.write_all(&part).await.is_err() {
                return;
            }
        }
    });
    url
}

#[tokio::test]
async fn fetch_rejects_oversized_http_bodies() {
    let client = reqwest::Client::new();

    // A declared length over the limit is rejected before any body is read.
    let url = serve_once(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_FILE_BYTES + 1
        ),
        vec![],
    )
    .await;
    let err = fetch(&client, &url).await.expect_err("declared too large");
    assert!(err.to_string().contains("is at least"), "{err}");

    // Without a length, the stream is cut off once it passes the limit.
    let chunk = vec![b'x'; 64 * 1024];
    let chunks = (0..=MAX_FILE_BYTES / chunk.len())
        .map(|_| {
            let mut part = format!("{:x}\r\n", chunk.len()).into_bytes();
            part.extend_from_slice(&chunk);
            part.extend_from_slice(b"\r\n");
            part
        })
        .chain(std::iter::once(b"0\r\n\r\n".to_vec()))
        .collect();
    let url = serve_once(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_owned(),
        chunks,
    )
    .await;
    let err = fetch(&client, &url).await.expect_err("streamed too large");
    assert!(err.to_string().contains("is at least"), "{err}");

    let url = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n".to_owned(),
        vec![b"{}".to_vec()],
    )
    .await;
    assert_eq!(fetch(&client, &url).await.expect("small body"), b"{}");
}

#[tokio::test]
async fn refresh_without_url_fails() {
    assert!(RuntimeDenylist::default().refresh().await.is_err());
}

pub(crate) mod origin_sender {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{
        BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
        HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, Indexer, KnownHyperlaneDomain,
        TxnInfo, H512, U256,
    };

    use super::*;

    /// Fake provider: `sender` of `None` is a transport error.
    #[derive(Debug)]
    pub(crate) struct SenderProvider {
        pub(crate) sender: Option<H256>,
        pub(crate) not_found: bool,
        pub(crate) calls: AtomicUsize,
    }

    impl SenderProvider {
        pub(crate) fn new(sender: Option<H256>) -> Self {
            Self {
                sender,
                not_found: false,
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl HyperlaneChain for SenderProvider {
        fn domain(&self) -> &HyperlaneDomain {
            unimplemented!()
        }
        fn provider(&self) -> Box<dyn HyperlaneProvider> {
            unimplemented!()
        }
    }

    #[async_trait::async_trait]
    impl HyperlaneProvider for SenderProvider {
        async fn get_block_by_height(&self, _: u64) -> ChainResult<BlockInfo> {
            unimplemented!()
        }
        async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.not_found {
                return Err(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash).into());
            }
            let sender = self
                .sender
                .ok_or_else(|| ChainCommunicationError::from_other_str("rpc down"))?;
            Ok(TxnInfo {
                hash: *hash,
                gas_limit: U256::zero(),
                max_priority_fee_per_gas: None,
                max_fee_per_gas: None,
                gas_price: None,
                nonce: 0,
                sender,
                recipient: None,
                receipt: None,
                raw_input_data: None,
            })
        }
        async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
            unimplemented!()
        }
        async fn get_balance(&self, _: String) -> ChainResult<U256> {
            unimplemented!()
        }
        async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
            unimplemented!()
        }
    }

    /// Fake message indexer: `signers` is what `fetch_tx_signers_by_sequence` returns.
    #[derive(Debug)]
    pub(crate) struct SignerIndexer {
        pub(crate) signers: Option<Vec<H256>>,
        pub(crate) fail: bool,
        pub(crate) calls: AtomicUsize,
    }

    impl SignerIndexer {
        pub(crate) fn unsupported() -> Self {
            Self {
                signers: None,
                fail: false,
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait::async_trait]
    impl Indexer<HyperlaneMessage> for SignerIndexer {
        async fn fetch_logs_in_range(
            &self,
            _: std::ops::RangeInclusive<u32>,
        ) -> ChainResult<
            Vec<(
                hyperlane_core::Indexed<HyperlaneMessage>,
                hyperlane_core::LogMeta,
            )>,
        > {
            unimplemented!()
        }
        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            unimplemented!()
        }
        async fn fetch_tx_signers_by_sequence(
            &self,
            _: u32,
            _: Option<H512>,
        ) -> ChainResult<Option<Vec<H256>>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(ChainCommunicationError::from_other_str("rpc down"));
            }
            Ok(self.signers.clone())
        }
    }

    struct Setup {
        _dir: tempfile::TempDir,
        db: HyperlaneRocksDB,
        provider: Arc<SenderProvider>,
        indexer: Arc<SignerIndexer>,
        check: OriginSenderCheck,
    }

    fn setup_with(
        rules: serde_json::Value,
        provider: SenderProvider,
        indexer: SignerIndexer,
    ) -> Setup {
        let dir = tempfile::tempdir().expect("tempdir");
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let db = HyperlaneRocksDB::new(&domain, DB::from_path(dir.path()).expect("db"));
        let provider = Arc::new(provider);
        let indexer = Arc::new(indexer);
        let check = OriginSenderCheck::new(
            Arc::new(RuntimeDenylist::from_rules_for_test(rules)),
            provider.clone(),
            indexer.clone(),
        );
        Setup {
            _dir: dir,
            db,
            provider,
            indexer,
            check,
        }
    }

    fn setup(rules: serde_json::Value, sender: Option<H256>) -> Setup {
        setup_with(
            rules,
            SenderProvider::new(sender),
            SignerIndexer::unsupported(),
        )
    }

    fn stored_message(db: &HyperlaneRocksDB) -> HyperlaneMessage {
        let message = HyperlaneMessage {
            nonce: rand::random(),
            sender: H256::random(),
            ..Default::default()
        };
        db.store_dispatched_tx_hash_by_message_id(&message.id(), &H512::random())
            .expect("store tx hash");
        message
    }

    #[tokio::test]
    async fn denies_listed_origin_sender_and_shares_the_lookup() {
        let s = setup(
            json!([address_rule(TRON_ADDRESS)]),
            Some(evm(TRON_ADDRESS_HEX)),
        );
        let message = stored_message(&s.db);
        for _ in 0..2 {
            let reason = s.check.deny_reason(&s.db, &message).await.expect("ok");
            assert!(reason.is_some());
        }
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 1);
        // Queue eviction sees the cached signers without another RPC call.
        assert!(s
            .check
            .denylist
            .deny_reason_for_cached_signers(&message.id())
            .await
            .is_some());
    }

    #[tokio::test]
    async fn allows_unlisted_origin_sender() {
        let s = setup(json!([address_rule(EVM_ADDRESS)]), Some(H256::random()));
        let message = stored_message(&s.db);
        let reason = s.check.deny_reason(&s.db, &message).await.expect("ok");
        assert_eq!(reason, None);
    }

    #[tokio::test]
    async fn skips_lookup_without_address_rules() {
        let s = setup(json!([message_rule(H256::random())]), None);
        let message = stored_message(&s.db);
        assert_eq!(
            s.check.deny_reason(&s.db, &message).await.expect("ok"),
            None
        );
        assert_eq!(s.indexer.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn hash_not_stored_yet_is_retried_until_it_is() {
        // The hash is written after the message, so a missing (or zero) hash
        // must not be cached as unknown: that would bypass the check.
        let s = setup(json!([address_rule(EVM_ADDRESS)]), Some(evm(EVM_ADDRESS)));
        let message = HyperlaneMessage::default();
        let err = s
            .check
            .deny_reason(&s.db, &message)
            .await
            .expect_err("no hash");
        assert!(is_hash_not_stored(&err), "{err}");
        s.db.store_dispatched_tx_hash_by_message_id(&message.id(), &H512::zero())
            .expect("store");
        let err = s
            .check
            .deny_reason(&s.db, &message)
            .await
            .expect_err("zero hash");
        assert!(is_hash_not_stored(&err), "{err}");
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 0);

        s.db.store_dispatched_tx_hash_by_message_id(&message.id(), &H512::random())
            .expect("store");
        let reason = s.check.deny_reason(&s.db, &message).await.expect("ok");
        assert!(reason.is_some());
    }

    #[tokio::test]
    async fn zero_sender_is_unknown() {
        let s = setup(json!([address_rule(EVM_ADDRESS)]), Some(H256::zero()));
        let message = stored_message(&s.db);
        let reason = s.check.deny_reason(&s.db, &message).await.expect("ok");
        assert_eq!(reason, None);
    }

    #[tokio::test]
    async fn missing_tx_is_unknown_not_an_error() {
        let s = setup_with(
            json!([address_rule(EVM_ADDRESS)]),
            SenderProvider {
                not_found: true,
                ..SenderProvider::new(None)
            },
            SignerIndexer::unsupported(),
        );
        let message = stored_message(&s.db);
        for _ in 0..2 {
            let reason = s.check.deny_reason(&s.db, &message).await.expect("ok");
            assert_eq!(reason, None);
        }
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn transport_errors_are_retried_until_given_up() {
        let s = setup(json!([address_rule(EVM_ADDRESS)]), None);
        let message = stored_message(&s.db);
        assert!(s.check.deny_reason(&s.db, &message).await.is_err());
        // Errors aren't cached, so the next attempt looks up again.
        assert!(s.check.deny_reason(&s.db, &message).await.is_err());
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 2);

        // Giving up isn't cached: the next attempt still looks up.
        s.check.record_give_up();
        assert!(s.check.deny_reason(&s.db, &message).await.is_err());
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 3);

        let s = setup_with(
            json!([address_rule(EVM_ADDRESS)]),
            SenderProvider::new(None),
            SignerIndexer {
                fail: true,
                ..SignerIndexer::unsupported()
            },
        );
        assert!(s
            .check
            .deny_reason(&s.db, &HyperlaneMessage::default())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn indexer_reporting_no_tx_is_unknown() {
        // Sealevel returns no signers when the dispatch block has no matching
        // tx: a definite unknown, so no retry or provider fallback.
        let s = setup_with(
            json!([address_rule(EVM_ADDRESS)]),
            SenderProvider::new(None),
            SignerIndexer {
                signers: Some(vec![]),
                ..SignerIndexer::unsupported()
            },
        );
        let message = HyperlaneMessage::default();
        for _ in 0..2 {
            assert_eq!(
                s.check.deny_reason(&s.db, &message).await.expect("ok"),
                None
            );
        }
        assert_eq!(s.indexer.calls.load(Ordering::SeqCst), 1);
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn indexer_signers_cover_sponsored_deposits() {
        // Sealevel: no stored hash, the indexer resolves every signer, and a
        // sponsor paying fees doesn't hide the listed depositor.
        let sponsor = H256::random();
        let depositor = hyperlane_core::utils::hex_or_base58_or_bech32_to_h256(SOLANA_ADDRESS)
            .expect("valid address");
        let s = setup_with(
            json!([address_rule(SOLANA_ADDRESS)]),
            SenderProvider::new(None),
            SignerIndexer {
                signers: Some(vec![sponsor, depositor]),
                ..SignerIndexer::unsupported()
            },
        );
        let message = HyperlaneMessage::default();
        let reason = s.check.deny_reason(&s.db, &message).await.expect("ok");
        assert!(reason.is_some());
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 0);
    }
}
