//! Runtime denylist: rules fetched from a URL and re-polled, so operators can
//! block messages without a config change, redeploy or restart.
//!
//! File shape:
//! ```json
//! {
//!   "rules": [
//!     { "reason": "...", "addedBy": "...", "expiresAt": "2026-12-01T00:00:00Z",
//!       "match": { "messageId": "0x..." } },
//!     { "reason": "...", "addedBy": "...", "address": "0x..." }
//!   ]
//! }
//! ```
//! `match` takes the same fields as a `MatchingList` element. `address` takes
//! EVM hex (20 or 32 bytes), Solana base58, Tron base58 or bech32. It matches
//! the message sender, the message recipient, or the warp transfer recipient
//! (the first 32 bytes of the body). Expired rules are ignored.
//!
//! A file that fails to fetch or parse leaves the previous rules in place. If
//! the first fetch at startup fails, the relayer starts with no runtime rules.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use ethers::utils::hex;
use eyre::{bail, ensure, eyre, Context, Result};
use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::CoreMetrics;
use hyperlane_core::{
    matching_list::ListElement, utils::hex_or_base58_or_bech32_to_h256, HyperlaneMessage,
    HyperlaneProvider, Indexer, PendingOperation, H256,
};
use parking_lot::RwLock;
use prometheus::{IntCounter, IntCounterVec, IntGauge, IntGaugeVec};
use serde::Deserialize;
use serde_json::{Map, Value};
use tracing::{debug, error, info, warn};
use url::Url;

use crate::settings::matching_list::{MatchInfo, MatchingList};

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const INITIAL_FETCH_ATTEMPTS: u32 = 3;
const INITIAL_FETCH_BACKOFF: Duration = Duration::from_secs(2);
const MATCH_KEYS: [&str; 6] = [
    "messageid",
    "origindomain",
    "senderaddress",
    "destinationdomain",
    "recipientaddress",
    "bodyregex",
];

/// Where the runtime denylist is fetched from and how often.
#[derive(Debug, Clone)]
pub struct RuntimeDenylistConf {
    /// `https://`, `http://` or `file://` URL of the denylist JSON.
    pub url: Url,
    /// Time between fetches.
    pub poll_interval: Duration,
}

#[derive(Debug)]
struct MessageRule {
    list: MatchingList,
    reason: String,
}

#[derive(Debug)]
struct AddressRule {
    address: H256,
    reason: String,
}

/// Rules active at one point in time.
#[derive(Debug, Default)]
struct ActiveRules {
    messages: Vec<MessageRule>,
    /// All `messages` rules in one list, so a miss costs one pass.
    all_messages: MatchingList,
    addresses: Vec<AddressRule>,
    /// Canonical form of the active rules, used to detect changes.
    fingerprint: Vec<String>,
}

impl ActiveRules {
    fn is_empty(&self) -> bool {
        self.messages.is_empty() && self.addresses.is_empty()
    }

    fn find(
        &self,
        info: MatchInfo,
        sender: &H256,
        recipient: &H256,
        body: &[u8],
    ) -> Option<String> {
        if self.all_messages.matches(info.clone(), false) {
            // Only on a hit: find which rule matched, for its reason.
            return self
                .messages
                .iter()
                .find(|rule| rule.list.matches(info.clone(), false))
                .map(|rule| rule.reason.clone());
        }
        // Warp transfer bodies start with the 32-byte token recipient.
        let warp_recipient = body.get(..32).map(H256::from_slice);
        self.addresses
            .iter()
            .find(|rule| {
                rule.address == *sender
                    || rule.address == *recipient
                    || warp_recipient == Some(rule.address)
            })
            .map(|rule| rule.reason.clone())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    rules: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawRule {
    reason: String,
    added_by: String,
    expires_at: Option<String>,
    #[serde(rename = "match")]
    match_: Option<Map<String, Value>>,
    address: Option<String>,
}

/// Parse a denylist file, keeping only rules that have not expired at `now`.
/// Any invalid rule rejects the whole file.
fn parse_rules(bytes: &[u8], now: DateTime<Utc>) -> Result<ActiveRules> {
    let file: RawFile = serde_json::from_slice(bytes).context("Invalid denylist JSON")?;
    let mut active = ActiveRules::default();
    for (index, raw) in file.rules.into_iter().enumerate() {
        let canonical = raw.to_string();
        let rule: RawRule = serde_json::from_value(raw)
            .with_context(|| format!("Invalid denylist rule at index {index}"))?;
        let parsed = parse_rule(rule, now)
            .with_context(|| format!("Invalid denylist rule at index {index}"))?;
        match parsed {
            ParsedRule::Expired => {}
            ParsedRule::Message(rule) => {
                active.messages.push(rule);
                active.fingerprint.push(canonical);
            }
            ParsedRule::Address(rule) => {
                active.addresses.push(rule);
                active.fingerprint.push(canonical);
            }
        }
    }
    active.fingerprint.sort_unstable();
    let elements: Vec<_> = active
        .messages
        .iter()
        .filter_map(|rule| rule.list.0.as_ref())
        .flatten()
        .cloned()
        .collect();
    active.all_messages = MatchingList(Some(elements).filter(|e| !e.is_empty()));
    Ok(active)
}

enum ParsedRule {
    Expired,
    Message(MessageRule),
    Address(AddressRule),
}

fn parse_rule(rule: RawRule, now: DateTime<Utc>) -> Result<ParsedRule> {
    ensure!(!rule.reason.trim().is_empty(), "`reason` must not be empty");
    ensure!(
        !rule.added_by.trim().is_empty(),
        "`addedBy` must not be empty"
    );
    let expired = match &rule.expires_at {
        Some(expires_at) => {
            DateTime::parse_from_rfc3339(expires_at)
                .context("`expiresAt` must be an RFC 3339 timestamp")?
                .with_timezone(&Utc)
                <= now
        }
        None => false,
    };
    let reason = format!("{} (added by {})", rule.reason.trim(), rule.added_by.trim());
    let parsed = match (rule.match_, rule.address) {
        (Some(match_), None) => ParsedRule::Message(MessageRule {
            list: parse_match(match_)?,
            reason,
        }),
        (None, Some(address)) => ParsedRule::Address(AddressRule {
            address: parse_address(&address)?,
            reason,
        }),
        _ => bail!("Exactly one of `match` or `address` must be set"),
    };
    // Validate expired rules too, so a typo is caught before the rule matters.
    Ok(if expired { ParsedRule::Expired } else { parsed })
}

fn parse_match(match_: Map<String, Value>) -> Result<MatchingList> {
    let mut lowercased = Map::new();
    for (key, value) in match_ {
        let key = key.to_lowercase();
        ensure!(
            MATCH_KEYS.contains(&key.as_str()),
            "Unknown `match` field `{key}`"
        );
        lowercased.insert(key, value);
    }
    // ListElement treats a missing field as a wildcard, so an empty or
    // all-wildcard rule would block every message.
    let has_filter = lowercased.values().any(|value| value.as_str() != Some("*"));
    ensure!(
        has_filter,
        "`match` must constrain at least one field; it would block every message"
    );
    let element: ListElement =
        serde_json::from_value(Value::Object(lowercased)).context("Invalid `match`")?;
    Ok(MatchingList(Some(vec![element])))
}

fn parse_address(address: &str) -> Result<H256> {
    let address = hex_or_base58_or_bech32_to_h256(address.trim())
        .context("`address` must be EVM hex, base58 or bech32")?;
    // The zero address is the padding in short addresses and empty fields.
    ensure!(!address.is_zero(), "`address` must not be zero");
    Ok(address)
}

/// Shared, hot-swappable view of the runtime denylist.
#[derive(Debug, Default)]
pub struct RuntimeDenylist {
    rules: RwLock<Arc<ActiveRules>>,
    version: AtomicU64,
    source: Option<DenylistSource>,
    /// Serialises fetch-and-replace so an older fetch can't overwrite a newer one.
    refresh_lock: tokio::sync::Mutex<()>,
    metrics: Option<RuntimeDenylistMetrics>,
}

#[derive(Debug)]
struct DenylistSource {
    client: reqwest::Client,
    conf: RuntimeDenylistConf,
}

/// Counts of active rules after a refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDenylistSummary {
    /// Increments whenever the active rules change.
    pub version: u64,
    /// Active `match` rules.
    pub message_rules: usize,
    /// Active `address` rules.
    pub address_rules: usize,
}

impl RuntimeDenylist {
    /// Create an empty denylist that fetches from `conf`, if set.
    pub fn new(conf: Option<RuntimeDenylistConf>, metrics: RuntimeDenylistMetrics) -> Result<Self> {
        let source = conf
            .map(|conf| -> Result<_> {
                let client = reqwest::Client::builder()
                    .timeout(FETCH_TIMEOUT)
                    .build()
                    .context("Failed to build runtime denylist HTTP client")?;
                Ok(DenylistSource { client, conf })
            })
            .transpose()?;
        Ok(Self {
            source,
            metrics: Some(metrics),
            ..Default::default()
        })
    }

    /// Build a denylist from a JSON `rules` array.
    #[cfg(test)]
    pub(crate) fn from_rules_for_test(rules: serde_json::Value) -> Self {
        let denylist = Self::default();
        denylist.set_rules_for_test(rules);
        denylist
    }

    /// Replace the rules with a JSON `rules` array.
    #[cfg(test)]
    pub(crate) fn set_rules_for_test(&self, rules: serde_json::Value) {
        let bytes = serde_json::to_vec(&serde_json::json!({ "rules": rules })).expect("json");
        self.replace(parse_rules(&bytes, Utc::now()).expect("valid rules"));
    }

    /// Whether a source URL is configured.
    pub fn is_enabled(&self) -> bool {
        self.source.is_some()
    }

    /// Incremented whenever the set of active rules changes.
    pub fn version(&self) -> u64 {
        self.version.load(Ordering::Acquire)
    }

    /// Current version and rule counts.
    pub fn summary(&self) -> RuntimeDenylistSummary {
        let rules = self.rules.read().clone();
        RuntimeDenylistSummary {
            version: self.version(),
            message_rules: rules.messages.len(),
            address_rules: rules.addresses.len(),
        }
    }

    /// Whether any `address` rules are active.
    pub fn has_address_rules(&self) -> bool {
        !self.rules.read().addresses.is_empty()
    }

    /// Returns the reason if an `address` rule names `address`.
    pub fn deny_reason_for_address(&self, address: &H256) -> Option<String> {
        self.rules
            .read()
            .addresses
            .iter()
            .find(|rule| rule.address == *address)
            .map(|rule| rule.reason.clone())
    }

    /// Returns the reason if the message is denied.
    pub fn deny_reason_for_message(&self, message: &HyperlaneMessage) -> Option<String> {
        let rules = self.rules.read().clone();
        if rules.is_empty() {
            return None;
        }
        rules.find(
            MatchInfo::from(message),
            &message.sender,
            &message.recipient,
            &message.body,
        )
    }

    /// Returns the reason if the operation is denied.
    pub fn deny_reason_for_op(&self, op: &dyn PendingOperation) -> Option<String> {
        let rules = self.rules.read().clone();
        if rules.is_empty() {
            return None;
        }
        let info = MatchInfo {
            src_msg_id: op.id(),
            src_domain: op.origin_domain_id(),
            src_addr: op.sender_address(),
            dst_domain: op.destination_domain().id(),
            dst_addr: op.recipient_address(),
            body: hex::encode(op.body()),
        };
        rules.find(info, op.sender_address(), op.recipient_address(), op.body())
    }

    /// Record that a queued operation was dropped because it is denied.
    pub fn record_eviction(&self, destination: &str, queue: &str) {
        if let Some(metrics) = &self.metrics {
            metrics
                .evicted_operations
                .with_label_values(&[destination, queue])
                .inc();
        }
    }

    /// Replace the active rules. Bumps the version only if they changed.
    fn replace(&self, rules: ActiveRules) {
        let changed = {
            let mut current = self.rules.write();
            if current.fingerprint == rules.fingerprint {
                false
            } else {
                *current = Arc::new(rules);
                true
            }
        };
        if changed {
            self.version.fetch_add(1, Ordering::AcqRel);
        }
        let summary = self.summary();
        if let Some(metrics) = &self.metrics {
            metrics
                .active_rules
                .with_label_values(&["message"])
                .set(summary.message_rules as i64);
            metrics
                .active_rules
                .with_label_values(&["address"])
                .set(summary.address_rules as i64);
            metrics
                .last_refresh_success_timestamp
                .set(Utc::now().timestamp());
        }
        if changed {
            info!(?summary, "Runtime denylist updated");
        }
    }

    /// Fetch, parse and apply the denylist once. On failure the previous
    /// rules stay active.
    pub async fn refresh(&self) -> Result<RuntimeDenylistSummary> {
        let source = self
            .source
            .as_ref()
            .ok_or_else(|| eyre!("Runtime denylist URL is not configured"))?;
        let _guard = self.refresh_lock.lock().await;
        let result = async {
            let bytes = fetch(&source.client, &source.conf.url).await?;
            parse_rules(&bytes, Utc::now())
        }
        .await;
        match result {
            Ok(rules) => {
                self.replace(rules);
                Ok(self.summary())
            }
            Err(err) => {
                if let Some(metrics) = &self.metrics {
                    metrics.refresh_failures.inc();
                }
                Err(err)
            }
        }
    }

    /// Load the denylist before message processing starts. On repeated
    /// failure, log and continue with no runtime rules; the poller keeps
    /// retrying.
    pub async fn initial_load(&self) {
        let Some(source) = &self.source else {
            return;
        };
        for attempt in 1..=INITIAL_FETCH_ATTEMPTS {
            match self.refresh().await {
                Ok(summary) => {
                    info!(?summary, url = %source.conf.url, "Loaded runtime denylist");
                    return;
                }
                Err(err) => warn!(
                    attempt,
                    url = %source.conf.url,
                    error = ?err,
                    "Failed to load runtime denylist"
                ),
            }
            if attempt < INITIAL_FETCH_ATTEMPTS {
                tokio::time::sleep(INITIAL_FETCH_BACKOFF).await;
            }
        }
        error!(
            url = %source.conf.url,
            "Starting without runtime denylist rules; messages they would block will be relayed until a fetch succeeds"
        );
    }

    /// Re-fetch the denylist forever. Returns immediately if no URL is set.
    pub async fn poll(self: Arc<Self>) {
        let Some(source) = &self.source else {
            return;
        };
        let mut interval = tokio::time::interval(source.conf.poll_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick fires immediately; initial_load already covered it.
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(err) = self.refresh().await {
                error!(url = %source.conf.url, error = ?err, "Failed to refresh runtime denylist; keeping previous rules");
            }
        }
    }
}

async fn fetch(client: &reqwest::Client, url: &Url) -> Result<Vec<u8>> {
    let bytes = match url.scheme() {
        "file" => {
            let path = url
                .to_file_path()
                .map_err(|()| eyre!("Invalid file URL {url}"))?;
            tokio::fs::read(&path)
                .await
                .with_context(|| format!("Failed to read {}", path.display()))?
        }
        "http" | "https" => client
            .get(url.clone())
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .to_vec(),
        scheme => bail!("Unsupported runtime denylist URL scheme `{scheme}`"),
    };
    ensure!(
        bytes.len() <= MAX_FILE_BYTES,
        "Runtime denylist is {} bytes; the limit is {MAX_FILE_BYTES}",
        bytes.len()
    );
    Ok(bytes)
}

/// Checks the wallet that sent a message's origin transaction against the
/// runtime `address` rules. A warp transfer's depositor appears only there:
/// the message sender is the origin router.
pub struct OriginSenderCheck {
    denylist: Arc<RuntimeDenylist>,
    provider: Arc<dyn HyperlaneProvider>,
    /// Resolves dispatch tx signers where the tx id isn't stored (Sealevel).
    indexer: Arc<dyn Indexer<HyperlaneMessage>>,
}

impl std::fmt::Debug for OriginSenderCheck {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OriginSenderCheck").finish_non_exhaustive()
    }
}

impl OriginSenderCheck {
    pub fn new(
        denylist: Arc<RuntimeDenylist>,
        provider: Arc<dyn HyperlaneProvider>,
        indexer: Arc<dyn Indexer<HyperlaneMessage>>,
    ) -> Self {
        Self {
            denylist,
            provider,
            indexer,
        }
    }

    /// Record a message dropped at prepare because of its origin tx sender.
    pub fn record_drop(&self, destination: &str) {
        self.denylist.record_eviction(destination, "origin_sender");
    }

    /// Returns the reason if a signer of the origin tx is denied. `signers`
    /// caches the lookup across calls, including an empty result when the
    /// tx can't be resolved, so it runs once per loaded message.
    pub async fn deny_reason(
        &self,
        db: &dyn HyperlaneDb,
        message: &HyperlaneMessage,
        signers: &mut Option<Vec<H256>>,
    ) -> Result<Option<String>> {
        if !self.denylist.has_address_rules() {
            return Ok(None);
        }
        if signers.is_none() {
            *signers = Some(self.lookup_signers(db, message).await?);
        }
        Ok(signers
            .iter()
            .flatten()
            .find_map(|signer| self.denylist.deny_reason_for_address(signer)))
    }

    async fn lookup_signers(
        &self,
        db: &dyn HyperlaneDb,
        message: &HyperlaneMessage,
    ) -> Result<Vec<H256>> {
        // Some writers (e.g. the relay API) can store a zero hash.
        let tx_hash = db
            .retrieve_dispatched_tx_hash_by_message_id(&message.id())?
            .filter(|tx_hash| !tx_hash.is_zero());
        if let Some(signers) = self
            .indexer
            .fetch_tx_signers_by_sequence(message.nonce, tx_hash)
            .await?
        {
            return Ok(signers);
        }
        let Some(tx_hash) = tx_hash else {
            debug!(message_id = ?message.id(), "Dispatch tx unknown; skipping origin sender check");
            return Ok(vec![]);
        };
        Ok(vec![self.provider.get_txn_by_hash(&tx_hash).await?.sender])
    }
}

/// Metrics for the runtime denylist.
#[derive(Debug, Clone)]
pub struct RuntimeDenylistMetrics {
    active_rules: IntGaugeVec,
    last_refresh_success_timestamp: IntGauge,
    refresh_failures: IntCounter,
    evicted_operations: IntCounterVec,
}

impl RuntimeDenylistMetrics {
    /// Register runtime denylist metrics.
    pub fn new(metrics: &CoreMetrics) -> Result<Self> {
        Ok(Self {
            active_rules: metrics.new_int_gauge(
                "runtime_denylist_active_rules",
                "Active (unexpired) runtime denylist rules",
                &["kind"],
            )?,
            last_refresh_success_timestamp: metrics
                .new_int_gauge(
                    "runtime_denylist_last_refresh_success_timestamp_seconds",
                    "Unix time of the last successful runtime denylist fetch",
                    &[],
                )?
                .with_label_values::<&str>(&[]),
            refresh_failures: metrics
                .new_int_counter(
                    "runtime_denylist_refresh_failures_total",
                    "Failed runtime denylist fetches or parses",
                    &[],
                )?
                .with_label_values::<&str>(&[]),
            evicted_operations: metrics.new_int_counter(
                "runtime_denylist_evicted_operations_total",
                "Queued operations dropped because they matched the runtime denylist",
                &["destination", "queue"],
            )?,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;
