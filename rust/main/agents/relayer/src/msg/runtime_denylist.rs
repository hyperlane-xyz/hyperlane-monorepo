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
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use chrono::{DateTime, Utc};
use ethers::utils::hex;
use eyre::{bail, ensure, eyre, Context, Result};
use hyperlane_base::CoreMetrics;
use hyperlane_core::{
    matching_list::ListElement, utils::hex_or_base58_or_bech32_to_h256, HyperlaneMessage,
    PendingOperation, H256,
};
use parking_lot::RwLock;
use prometheus::{IntCounter, IntCounterVec, IntGauge, IntGaugeVec};
use serde::Deserialize;
use serde_json::{Map, Value};
use tracing::{error, info, warn};
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
    /// Last successfully fetched file, used if the startup fetch fails.
    pub cache_path: PathBuf,
}

#[derive(Debug, Clone)]
struct MessageRule {
    list: MatchingList,
    reason: String,
    expires_at: Option<DateTime<Utc>>,
    /// The rule's JSON, for change detection.
    canonical: String,
}

#[derive(Debug, Clone)]
struct AddressRule {
    address: H256,
    reason: String,
    expires_at: Option<DateTime<Utc>>,
    /// The rule's JSON, for change detection.
    canonical: String,
}

fn expired(expires_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    expires_at.is_some_and(|expires_at| expires_at <= now)
}

/// Rules active at one point in time.
#[derive(Debug, Default, Clone)]
struct ActiveRules {
    messages: Vec<MessageRule>,
    /// All `messages` rules in one list, so a miss costs one pass.
    all_messages: MatchingList,
    addresses: Vec<AddressRule>,
    /// Canonical form of the active rules, used to detect changes.
    fingerprint: Vec<String>,
}

impl ActiveRules {
    fn new(messages: Vec<MessageRule>, addresses: Vec<AddressRule>) -> Self {
        let mut fingerprint: Vec<_> = messages
            .iter()
            .map(|rule| rule.canonical.clone())
            .chain(addresses.iter().map(|rule| rule.canonical.clone()))
            .collect();
        fingerprint.sort_unstable();
        let elements: Vec<_> = messages
            .iter()
            .filter_map(|rule| rule.list.0.as_ref())
            .flatten()
            .cloned()
            .collect();
        Self {
            messages,
            all_messages: MatchingList(Some(elements).filter(|e| !e.is_empty())),
            addresses,
            fingerprint,
        }
    }

    /// The rules still active at `now`, if any have expired.
    fn without_expired(&self, now: DateTime<Utc>) -> Option<Self> {
        let any_expired = self
            .messages
            .iter()
            .map(|rule| rule.expires_at)
            .chain(self.addresses.iter().map(|rule| rule.expires_at))
            .any(|expires_at| expired(expires_at, now));
        any_expired.then(|| {
            Self::new(
                self.messages
                    .iter()
                    .filter(|rule| !expired(rule.expires_at, now))
                    .cloned()
                    .collect(),
                self.addresses
                    .iter()
                    .filter(|rule| !expired(rule.expires_at, now))
                    .cloned()
                    .collect(),
            )
        })
    }

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
    let mut messages = vec![];
    let mut addresses = vec![];
    for (index, raw) in file.rules.into_iter().enumerate() {
        let canonical = raw.to_string();
        let rule: RawRule = serde_json::from_value(raw)
            .with_context(|| format!("Invalid denylist rule at index {index}"))?;
        let parsed = parse_rule(rule, canonical)
            .with_context(|| format!("Invalid denylist rule at index {index}"))?;
        // Expired rules are still validated, so a typo is caught early.
        match parsed {
            ParsedRule::Message(rule) if !expired(rule.expires_at, now) => messages.push(rule),
            ParsedRule::Address(rule) if !expired(rule.expires_at, now) => addresses.push(rule),
            _ => {}
        }
    }
    Ok(ActiveRules::new(messages, addresses))
}

enum ParsedRule {
    Message(MessageRule),
    Address(AddressRule),
}

fn parse_rule(rule: RawRule, canonical: String) -> Result<ParsedRule> {
    ensure!(!rule.reason.trim().is_empty(), "`reason` must not be empty");
    ensure!(
        !rule.added_by.trim().is_empty(),
        "`addedBy` must not be empty"
    );
    let expires_at = rule
        .expires_at
        .map(|expires_at| {
            DateTime::parse_from_rfc3339(&expires_at)
                .map(|expires_at| expires_at.with_timezone(&Utc))
                .context("`expiresAt` must be an RFC 3339 timestamp")
        })
        .transpose()?;
    let reason = format!("{} (added by {})", rule.reason.trim(), rule.added_by.trim());
    Ok(match (rule.match_, rule.address) {
        (Some(match_), None) => ParsedRule::Message(MessageRule {
            list: parse_match(match_)?,
            reason,
            expires_at,
            canonical,
        }),
        (None, Some(address)) => ParsedRule::Address(AddressRule {
            address: parse_address(&address)?,
            reason,
            expires_at,
            canonical,
        }),
        _ => bail!("Exactly one of `match` or `address` must be set"),
    })
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
    let element: ListElement =
        serde_json::from_value(Value::Object(lowercased)).context("Invalid `match`")?;
    // Missing fields are wildcards, and `bodyRegex` alone can match anything
    // (`.*`, `""`), so require a specific value in at least one other field.
    ensure!(
        element.constrains_exact_field(),
        "`match` must set messageId, originDomain, senderAddress, destinationDomain or recipientAddress; otherwise it can block every message"
    );
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
        self.replace(parse_rules(&bytes, Utc::now()).expect("valid rules"), true);
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
    /// `fetched` is false when the rules come from the on-disk cache.
    fn replace(&self, rules: ActiveRules, fetched: bool) {
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
            if fetched {
                metrics
                    .last_refresh_success_timestamp
                    .set(Utc::now().timestamp());
            }
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
            parse_rules(&bytes, Utc::now()).map(|rules| (rules, bytes))
        }
        .await;
        match result {
            Ok((rules, bytes)) => {
                self.replace(rules, true);
                if let Err(err) = write_cache(&source.conf.cache_path, &bytes).await {
                    warn!(error = ?err, "Failed to cache runtime denylist");
                }
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
        let cached = tokio::fs::read(&source.conf.cache_path)
            .await
            .map_err(eyre::Report::from)
            .and_then(|bytes| parse_rules(&bytes, Utc::now()));
        match cached {
            Ok(rules) => {
                self.replace(rules, false);
                error!(
                    url = %source.conf.url,
                    summary = ?self.summary(),
                    "Starting with the cached runtime denylist; it may be stale until a fetch succeeds"
                );
            }
            Err(err) => error!(
                url = %source.conf.url,
                error = ?err,
                "Starting without runtime denylist rules; messages they would block will be relayed until a fetch succeeds"
            ),
        }
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
            // Expiries apply even while fetches fail.
            self.prune_expired().await;
        }
    }

    /// Drop rules whose `expiresAt` has passed. Bumps the version, so the
    /// loader rescans messages they were blocking.
    async fn prune_expired(&self) {
        let _guard = self.refresh_lock.lock().await;
        let pruned = self.rules.read().without_expired(Utc::now());
        if let Some(rules) = pruned {
            self.replace(rules, false);
        }
    }
}

/// Write via a temp file so a crash can't leave a truncated cache.
async fn write_cache(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, path).await?;
    Ok(())
}

/// Read at most `MAX_FILE_BYTES`, rejecting larger files before buffering them.
async fn fetch(client: &reqwest::Client, url: &Url) -> Result<Vec<u8>> {
    let too_large =
        |len: u64| eyre!("Runtime denylist is at least {len} bytes; the limit is {MAX_FILE_BYTES}");
    match url.scheme() {
        "file" => {
            let path = url
                .to_file_path()
                .map_err(|()| eyre!("Invalid file URL {url}"))?;
            let len = tokio::fs::metadata(&path)
                .await
                .with_context(|| format!("Failed to read {}", path.display()))?
                .len();
            if len > MAX_FILE_BYTES as u64 {
                return Err(too_large(len));
            }
            tokio::fs::read(&path)
                .await
                .with_context(|| format!("Failed to read {}", path.display()))
        }
        "http" | "https" => {
            let mut response = client.get(url.clone()).send().await?.error_for_status()?;
            if let Some(len) = response.content_length() {
                if len > MAX_FILE_BYTES as u64 {
                    return Err(too_large(len));
                }
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await? {
                if body.len().saturating_add(chunk.len()) > MAX_FILE_BYTES {
                    return Err(too_large(body.len().saturating_add(chunk.len()) as u64));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        }
        scheme => bail!("Unsupported runtime denylist URL scheme `{scheme}`"),
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
mod tests;
