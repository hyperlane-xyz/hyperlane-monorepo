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
use hyperlane_base::db::HyperlaneDb;
use hyperlane_base::CoreMetrics;
use hyperlane_core::{
    matching_list::ListElement, utils::hex_or_base58_or_bech32_to_h256, ChainCommunicationError,
    HyperlaneMessage, HyperlaneProvider, HyperlaneProviderError, Indexer, PendingOperation, H256,
};
use parking_lot::RwLock;
use prometheus::{IntCounter, IntCounterVec, IntGauge, IntGaugeVec};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::io::AsyncReadExt;
use tracing::{error, info, warn};
use url::Url;

use crate::settings::matching_list::{MatchInfo, MatchingList};

const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const TRON_ADDRESS_PREFIX: u8 = 0x41;
const ORIGIN_SIGNER_CACHE_CAPACITY: u64 = 100_000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const INITIAL_FETCH_ATTEMPTS: u32 = 3;
const INITIAL_FETCH_BACKOFF: Duration = Duration::from_secs(2);
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
    verify_match_tron_addresses(&match_)?;
    // Runtime feeds and their caches historically accepted any key casing.
    // Normalize keys only; addresses and regexes can be case-sensitive.
    let mut normalized = Map::new();
    for (key, value) in match_ {
        let key = key.to_lowercase();
        if let Some(existing) = normalized.get(&key) {
            ensure!(
                existing == &value,
                "Conflicting `match` aliases for `{key}`"
            );
            continue;
        }
        normalized.insert(key, value);
    }
    // Keep the shared parser strict, including unknown-field rejection.
    let element: ListElement =
        serde_json::from_value(Value::Object(normalized)).context("Invalid `match`")?;
    // Missing fields are wildcards, and `bodyRegex` alone can match anything
    // (`.*`, `""`), so require a specific value in at least one other field.
    ensure!(
        !element.has_empty_filter(),
        "`match` has an empty list, so it would block nothing"
    );
    ensure!(
        element.constrains_exact_field(),
        "`match` must set messageId, originDomain, senderAddress, destinationDomain or recipientAddress; otherwise it can block every message"
    );
    Ok(MatchingList(Some(vec![element])))
}

fn parse_address(address: &str) -> Result<H256> {
    let address = address.trim();
    let parsed = hex_or_base58_or_bech32_to_h256(address)
        .context("`address` must be EVM hex, base58 or bech32")?;
    verify_tron_checksum(address, &parsed)?;
    let address = parsed;
    // The zero address is the padding in short addresses and empty fields.
    ensure!(!address.is_zero(), "`address` must not be zero");
    Ok(address)
}

/// The shared parser reads any 25-byte base58 string as a Tron address
/// without checking it, so a typo would load and never match. Check the
/// `0x41` prefix and base58check checksum here rather than in the shared
/// parser, which is also compiled into the Sealevel programs.
fn verify_tron_checksum(address: &str, parsed: &H256) -> Result<()> {
    let Ok(bytes) = bs58::decode(address).into_vec() else {
        return Ok(());
    };
    // Only when the shared parser took its Tron branch (not bech32).
    if bytes.len() != 25 || parsed.as_bytes()[12..] != bytes[1..21] {
        return Ok(());
    }
    bs58::decode(address)
        .with_check(Some(TRON_ADDRESS_PREFIX))
        .into_vec()
        .map(|_| ())
        .map_err(|err| eyre!("Tron address `{address}` failed its prefix or checksum check ({err}); check for a typo"))
}

/// Tron addresses in a `match` rule's sender or recipient get the same check
/// as `address` rules.
fn verify_match_tron_addresses(match_: &Map<String, Value>) -> Result<()> {
    let addresses = match_
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.to_lowercase().as_str(),
                "senderaddress" | "recipientaddress"
            )
        })
        .flat_map(|(_, value)| match value {
            Value::Array(values) => values.iter().collect(),
            value => vec![value],
        })
        .filter_map(Value::as_str)
        .filter(|address| *address != "*");
    for address in addresses {
        // Invalid values fail when the rule is deserialized.
        if let Ok(parsed) = hex_or_base58_or_bech32_to_h256(address) {
            verify_tron_checksum(address, &parsed)?;
        }
    }
    Ok(())
}

/// Shared, hot-swappable view of the runtime denylist.
#[derive(Debug, Default)]
pub struct RuntimeDenylist {
    rules: RwLock<Arc<ActiveRules>>,
    version: AtomicU64,
    source: Option<DenylistSource>,
    /// Serialises fetch-and-replace so an older fetch can't overwrite a newer one.
    refresh_lock: tokio::sync::Mutex<()>,
    /// Origin tx signers already looked up, by message id.
    origin_signers: OriginSignerCache,
    metrics: Option<RuntimeDenylistMetrics>,
}

/// Bounded cache of origin tx signers. Shared, so reloads, rescans and queue
/// eviction reuse a lookup instead of repeating RPCs; a dispatch tx's signers
/// never change. An empty entry means the signers couldn't be determined.
#[derive(Debug)]
struct OriginSignerCache(moka::future::Cache<H256, Arc<Vec<H256>>>);

impl Default for OriginSignerCache {
    fn default() -> Self {
        Self(moka::future::Cache::new(ORIGIN_SIGNER_CACHE_CAPACITY))
    }
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

    /// Record looked-up origin tx signers for a message.
    #[cfg(test)]
    pub(crate) async fn cache_origin_signers_for_test(&self, message_id: H256, signers: Vec<H256>) {
        self.origin_signers
            .0
            .insert(message_id, Arc::new(signers))
            .await;
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

    /// Returns the reason if a queued operation is denied: by its message
    /// fields, or by origin tx signers already looked up at prepare (so an
    /// address rule added after prepare still applies). Never makes an RPC
    /// call.
    pub async fn deny_reason_for_queued_op(&self, op: &dyn PendingOperation) -> Option<String> {
        match self.deny_reason_for_op(op) {
            Some(reason) => Some(reason),
            None => self.deny_reason_for_cached_signers(&op.id()).await,
        }
    }

    /// Returns the reason if an already looked-up origin tx signer of the
    /// message is denied. Never makes an RPC call.
    pub async fn deny_reason_for_cached_signers(&self, message_id: &H256) -> Option<String> {
        if !self.has_address_rules() {
            return None;
        }
        let signers = self.origin_signers.0.get(message_id).await?;
        signers
            .iter()
            .find_map(|signer| self.deny_reason_for_address(signer))
    }

    fn record_origin_lookup(&self, outcome: &str) {
        if let Some(metrics) = &self.metrics {
            metrics
                .origin_signer_lookups
                .with_label_values(&[outcome])
                .inc();
        }
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
            let file = tokio::fs::File::open(&path)
                .await
                .with_context(|| format!("Failed to read {}", path.display()))?;
            // Read one byte past the limit, so an oversized file is detected
            // without buffering all of it.
            let mut bytes = Vec::new();
            file.take((MAX_FILE_BYTES as u64).saturating_add(1))
                .read_to_end(&mut bytes)
                .await
                .with_context(|| format!("Failed to read {}", path.display()))?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err(too_large(bytes.len() as u64));
            }
            Ok(bytes)
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

    /// Returns the reason if a signer of the origin tx is denied. Lookups are
    /// cached and shared, including an empty result when the signers can't
    /// be determined (no matching dispatch, tx not found, zero sender). Other errors
    /// aren't cached, so the caller can retry.
    pub async fn deny_reason(
        &self,
        db: &dyn HyperlaneDb,
        message: &HyperlaneMessage,
    ) -> Result<Option<String>> {
        if !self.denylist.has_address_rules() {
            return Ok(None);
        }
        let signers = self
            .denylist
            .origin_signers
            .0
            .try_get_with(message.id(), async {
                self.lookup_signers(db, message).await.map(Arc::new)
            })
            .await
            .map_err(|err| {
                if is_hash_not_stored(&err) {
                    DispatchHashNotStored.into()
                } else {
                    eyre!("{err:#}")
                }
            })?;
        Ok(signers
            .iter()
            .find_map(|signer| self.denylist.deny_reason_for_address(signer)))
    }

    /// Returns the reason if a signer already looked up for the message is
    /// denied. Never makes an RPC call.
    pub async fn cached_deny_reason(&self, message: &HyperlaneMessage) -> Option<String> {
        self.denylist
            .deny_reason_for_cached_signers(&message.id())
            .await
    }

    /// Record that a lookup kept failing and the message relays without
    /// this check. Not cached, so the next prepare looks up again.
    pub fn record_give_up(&self) {
        self.denylist.record_origin_lookup("gave_up");
    }

    async fn lookup_signers(
        &self,
        db: &dyn HyperlaneDb,
        message: &HyperlaneMessage,
    ) -> Result<Vec<H256>> {
        let result = self.lookup_signers_inner(db, message).await;
        let outcome = match &result {
            Ok(signers) if signers.is_empty() => "unknown",
            Ok(_) => "found",
            Err(err) if is_hash_not_stored(err) => "no_hash",
            Err(_) => "error",
        };
        self.denylist.record_origin_lookup(outcome);
        result
    }

    async fn lookup_signers_inner(
        &self,
        db: &dyn HyperlaneDb,
        message: &HyperlaneMessage,
    ) -> Result<Vec<H256>> {
        let message_id = message.id();
        // Some writers (e.g. the relay API) can store a zero hash.
        let tx_hash = db
            .retrieve_dispatched_tx_hash_by_message_id(&message_id)?
            .filter(|tx_hash| !tx_hash.is_zero());
        if let Some(signers) = self
            .indexer
            .fetch_tx_signers_by_sequence(message.nonce, tx_hash)
            .await?
        {
            return Ok(non_zero(signers, &message_id));
        }
        // The hash is written after the message (and by scraper backfill
        // later still), so a missing one may just not be stored yet. Don't
        // cache unknown; the caller waits briefly and reads the DB again.
        let Some(tx_hash) = tx_hash else {
            return Err(DispatchHashNotStored.into());
        };
        match self.provider.get_txn_by_hash(&tx_hash).await {
            Ok(txn) => Ok(non_zero(vec![txn.sender], &message_id)),
            // A pruned or reorged-out tx won't reappear; retrying only delays
            // the message.
            Err(err) if is_tx_not_found(&err) => {
                warn!(
                    ?message_id,
                    ?tx_hash,
                    "Dispatch tx not found; skipping origin sender check"
                );
                Ok(vec![])
            }
            Err(err) => Err(err.into()),
        }
    }
}

/// No dispatch tx hash is stored for the message: either not written yet, or
/// never (e.g. Cosmos block-level events, old DB backlog).
#[derive(Debug, thiserror::Error)]
#[error("Dispatch tx hash isn't stored")]
pub struct DispatchHashNotStored;

/// Whether a lookup failed only because no dispatch tx hash is stored.
pub fn is_hash_not_stored(err: &eyre::Report) -> bool {
    err.downcast_ref::<DispatchHashNotStored>().is_some()
}

/// Drop zero signers, which some providers (e.g. Radix, Aleo) return when
/// they can't determine the sender.
fn non_zero(signers: Vec<H256>, message_id: &H256) -> Vec<H256> {
    let signers: Vec<_> = signers
        .into_iter()
        .filter(|signer| !signer.is_zero())
        .collect();
    if signers.is_empty() {
        warn!(
            ?message_id,
            "Origin tx sender unknown; skipping origin sender check"
        );
    }
    signers
}

fn is_tx_not_found(err: &ChainCommunicationError) -> bool {
    let ChainCommunicationError::Other(wrapper) = err else {
        return false;
    };
    let err: &dyn std::error::Error = wrapper.as_ref();
    matches!(
        err.downcast_ref::<HyperlaneProviderError>(),
        Some(HyperlaneProviderError::CouldNotFindTransactionByHash(_))
    )
}

/// Metrics for the runtime denylist.
#[derive(Debug, Clone)]
pub struct RuntimeDenylistMetrics {
    active_rules: IntGaugeVec,
    last_refresh_success_timestamp: IntGauge,
    refresh_failures: IntCounter,
    evicted_operations: IntCounterVec,
    origin_signer_lookups: IntCounterVec,
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
            origin_signer_lookups: metrics.new_int_counter(
                "runtime_denylist_origin_signer_lookups_total",
                "Origin tx signer lookups for address rules, by outcome (found, unknown, error, gave_up)",
                &["outcome"],
            )?,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;
