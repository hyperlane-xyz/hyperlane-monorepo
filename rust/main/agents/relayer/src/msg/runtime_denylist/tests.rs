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
fn match_accepts_camel_and_lower_case_keys() {
    let msg = message(H256::random(), H256::random(), vec![]);
    for key in ["messageId", "messageid"] {
        let denylist = denylist_with(json!([
            { "reason": "r", "addedBy": "a", "match": { key: format!("{:?}", msg.id()) } }
        ]));
        assert!(denylist.deny_reason_for_message(&msg).is_some(), "{key}");
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
    std::fs::write(&source, file(json!([address_rule(EVM_ADDRESS)]))).expect("write");

    let first = denylist_at(Url::from_file_path(&source).expect("url"), cache.clone());
    first.refresh().await.expect("refresh");
    assert!(cache.exists());

    std::fs::remove_file(&source).expect("remove");
    let restarted = denylist_at(Url::from_file_path(&source).expect("url"), cache);
    restarted.initial_load().await;
    assert_eq!(restarted.summary().address_rules, 1);
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
async fn startup_without_fetch_or_cache_has_no_rules() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = Url::from_file_path(dir.path().join("missing.json")).expect("url");
    let denylist = denylist_at(missing, dir.path().join("cache.json"));
    denylist.initial_load().await;
    assert_eq!(
        denylist.summary(),
        RuntimeDenylistSummary {
            version: 0,
            message_rules: 0,
            address_rules: 0,
        }
    );
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
