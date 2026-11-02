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
    denylist.replace(parse(rules).expect("valid rules"));
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
    denylist.replace(parse(rules.clone()).expect("valid"));
    assert_eq!(denylist.version(), 1);
    denylist.replace(parse(rules).expect("valid"));
    assert_eq!(denylist.version(), 1);
    denylist.replace(parse(json!([])).expect("valid"));
    assert_eq!(denylist.version(), 2);
}

fn file_denylist(file: &NamedTempFile) -> RuntimeDenylist {
    let url = Url::from_file_path(file.path()).expect("absolute path");
    RuntimeDenylist::new(
        Some(RuntimeDenylistConf {
            url,
            poll_interval: Duration::from_secs(1),
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
async fn refresh_without_url_fails() {
    assert!(RuntimeDenylist::default().refresh().await.is_err());
}

pub(crate) mod origin_sender {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{
        BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
        HyperlaneDomain, HyperlaneProvider, KnownHyperlaneDomain, TxnInfo, H512, U256,
    };

    use super::*;

    #[derive(Debug)]
    pub(crate) struct SenderProvider {
        pub(crate) sender: Option<H256>,
        pub(crate) calls: AtomicUsize,
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

    struct Setup {
        _dir: tempfile::TempDir,
        db: HyperlaneRocksDB,
        provider: Arc<SenderProvider>,
        check: OriginSenderCheck,
    }

    fn setup(rules: serde_json::Value, sender: Option<H256>) -> Setup {
        let dir = tempfile::tempdir().expect("tempdir");
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
        let db = HyperlaneRocksDB::new(&domain, DB::from_path(dir.path()).expect("db"));
        let provider = Arc::new(SenderProvider {
            sender,
            calls: AtomicUsize::new(0),
        });
        let check = OriginSenderCheck::new(
            Arc::new(RuntimeDenylist::from_rules_for_test(rules)),
            provider.clone(),
        );
        Setup {
            _dir: dir,
            db,
            provider,
            check,
        }
    }

    fn stored_message(db: &HyperlaneRocksDB) -> H256 {
        let id = H256::random();
        db.store_dispatched_tx_hash_by_message_id(&id, &H512::random())
            .expect("store tx hash");
        id
    }

    #[tokio::test]
    async fn denies_listed_origin_sender_and_caches_lookup() {
        let s = setup(
            json!([address_rule(TRON_ADDRESS)]),
            Some(evm(TRON_ADDRESS_HEX)),
        );
        let id = stored_message(&s.db);
        let mut cached = None;
        for _ in 0..2 {
            let reason = s
                .check
                .deny_reason(&s.db, id, &mut cached)
                .await
                .expect("ok");
            assert!(reason.is_some());
        }
        assert_eq!(cached, Some(evm(TRON_ADDRESS_HEX)));
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn allows_unlisted_origin_sender() {
        let s = setup(json!([address_rule(EVM_ADDRESS)]), Some(H256::random()));
        let id = stored_message(&s.db);
        let reason = s.check.deny_reason(&s.db, id, &mut None).await.expect("ok");
        assert_eq!(reason, None);
    }

    #[tokio::test]
    async fn skips_lookup_without_address_rules_or_tx_hash() {
        let s = setup(json!([message_rule(H256::random())]), None);
        let id = stored_message(&s.db);
        assert_eq!(
            s.check.deny_reason(&s.db, id, &mut None).await.expect("ok"),
            None
        );

        let s = setup(json!([address_rule(EVM_ADDRESS)]), None);
        let unknown = H256::random();
        assert_eq!(
            s.check
                .deny_reason(&s.db, unknown, &mut None)
                .await
                .expect("ok"),
            None
        );
        assert_eq!(s.provider.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn lookup_failure_is_an_error() {
        let s = setup(json!([address_rule(EVM_ADDRESS)]), None);
        let id = stored_message(&s.db);
        assert!(s.check.deny_reason(&s.db, id, &mut None).await.is_err());
    }
}
