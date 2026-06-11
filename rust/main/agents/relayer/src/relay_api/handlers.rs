use axum::{
    extract::State,
    http::{HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use hyperlane_base::db::HyperlaneRocksDB;
use hyperlane_core::{
    HyperlaneLogStore, HyperlaneMessage, Indexer, InterchainGasPayment, QueueOperation, H256, H512,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

use crate::msg::pending_message::{MessageContext, PendingMessage};
use crate::relay_api::metrics::RelayApiMetrics;

/// Bounded cache for tracking recently submitted tx hashes to prevent replay attacks
pub enum TxHashCacheError {
    Duplicate,
    CacheFull,
}

pub struct TxHashCache {
    cache: HashMap<(String, String), Instant>,
    max_entries: usize,
    ttl: Duration,
}

impl TxHashCache {
    pub fn new(max_entries: usize) -> Self {
        Self::new_with_ttl(max_entries, Duration::from_secs(300))
    }

    pub fn new_with_ttl(max_entries: usize, ttl: Duration) -> Self {
        Self {
            cache: HashMap::new(),
            max_entries,
            ttl,
        }
    }

    /// Returns true if the (chain, tx_hash) pair is present and within TTL.
    /// Read-only — does not modify the cache or evict expired entries.
    pub fn contains(&self, chain: &str, tx_hash: &str) -> bool {
        let normalized = tx_hash
            .strip_prefix("0x")
            .or_else(|| tx_hash.strip_prefix("0X"))
            .unwrap_or(tx_hash)
            .to_lowercase();
        let key = (chain.to_owned(), normalized);
        self.cache
            .get(&key)
            .is_some_and(|&ts| Instant::now().duration_since(ts) < self.ttl)
    }

    /// Remove a previously inserted entry (used to roll back a reservation on handler error).
    pub fn remove(&mut self, chain: &str, tx_hash: &str) {
        let normalized = tx_hash
            .strip_prefix("0x")
            .or_else(|| tx_hash.strip_prefix("0X"))
            .unwrap_or(tx_hash)
            .to_lowercase();
        self.cache.remove(&(chain.to_owned(), normalized));
    }

    /// Check if tx_hash was recently submitted and insert if not.
    /// Returns `Ok(())` if new, `Err(TxHashCacheError)` if duplicate or cache full.
    pub fn check_and_insert(
        &mut self,
        chain: String,
        tx_hash: String,
    ) -> Result<(), TxHashCacheError> {
        let now = Instant::now();
        let normalized = tx_hash
            .strip_prefix("0x")
            .or_else(|| tx_hash.strip_prefix("0X"))
            .unwrap_or(&tx_hash)
            .to_lowercase();
        let key = (chain, normalized);

        // Clean expired entries if cache is getting large (75% threshold)
        if self.cache.len() > self.max_entries.saturating_mul(3) / 4 {
            let ttl = self.ttl;
            self.cache
                .retain(|_, &mut timestamp| now.duration_since(timestamp) < ttl);
        }

        // Check for duplicate within TTL
        if let Some(&timestamp) = self.cache.get(&key) {
            if now.duration_since(timestamp) < self.ttl {
                return Err(TxHashCacheError::Duplicate);
            }
        }

        if self.cache.len() >= self.max_entries {
            warn!(
                cache_size = self.cache.len(),
                max_entries = self.max_entries,
                "TX hash cache full, rejecting request"
            );
            return Err(TxHashCacheError::CacheFull);
        }

        self.cache.insert(key, now);
        Ok(())
    }
}

/// RAII guard for a dedup-cache reservation.
///
/// On creation the slot is already locked in the cache. Calling [`commit`] keeps the
/// entry alive for the TTL (duplicate detection). If the guard is dropped without
/// committing — including when an async handler task is cancelled mid-await — the
/// reservation is removed so the client can retry with the same tx hash.
pub struct TxHashReservation {
    cache: Arc<Mutex<TxHashCache>>,
    chain: String,
    tx_hash: String,
    committed: bool,
}

impl TxHashReservation {
    fn new(cache: Arc<Mutex<TxHashCache>>, chain: String, tx_hash: String) -> Self {
        Self {
            cache,
            chain,
            tx_hash,
            committed: false,
        }
    }

    /// Mark this reservation as permanent. Drop will no longer remove the entry.
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for TxHashReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.cache.lock().remove(&self.chain, &self.tx_hash);
        }
    }
}

#[derive(Clone)]
pub struct ServerState {
    // Required: server cannot function without these
    indexers: HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
    /// IGP indexers keyed by origin domain id. Used to eagerly store gas payments from a
    /// tx receipt before injecting the message into the processor queue, so the relayer's
    /// gas payment check never races the background `tx_id_indexer_task`.
    igp_indexers: HashMap<u32, Arc<dyn Indexer<InterchainGasPayment>>>,
    dbs: HashMap<u32, HyperlaneRocksDB>,
    /// Batch send channels keyed by destination domain id. Messages sent here are
    /// inserted atomically into the prepare queue so all siblings from the same
    /// origin tx always land in the same `process_batch` call.
    batch_send_channels: HashMap<u32, UnboundedSender<Vec<QueueOperation>>>,
    msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>,
    metrics: RelayApiMetrics,
    // Optional features
    rate_limiter: Option<Arc<RwLock<RateLimiter>>>,
    tx_hash_cache: Option<Arc<Mutex<TxHashCache>>>,
    cors_origins: Vec<String>,
    message_whitelist: Option<Arc<crate::settings::matching_list::MatchingList>>,
    message_blacklist: Option<Arc<crate::settings::matching_list::MatchingList>>,
    address_blacklist: Option<Arc<crate::msg::blacklist::AddressBlacklist>>,
}

impl ServerState {
    pub fn new(
        indexers: HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
        igp_indexers: HashMap<u32, Arc<dyn Indexer<InterchainGasPayment>>>,
        dbs: HashMap<u32, HyperlaneRocksDB>,
        batch_send_channels: HashMap<u32, UnboundedSender<Vec<QueueOperation>>>,
        msg_ctxs: HashMap<(u32, u32), Arc<MessageContext>>,
        metrics: RelayApiMetrics,
    ) -> Self {
        Self {
            indexers,
            igp_indexers,
            dbs,
            batch_send_channels,
            msg_ctxs,
            metrics,
            rate_limiter: None,
            tx_hash_cache: None,
            cors_origins: Vec::new(),
            message_whitelist: None,
            message_blacklist: None,
            address_blacklist: None,
        }
    }

    fn record_failure(&self, reason: &str) {
        self.metrics.inc_failure(reason);
    }

    fn record_success(&self) {
        self.metrics.inc_success();
    }

    pub fn with_tx_hash_cache(mut self, cache: Arc<Mutex<TxHashCache>>) -> Self {
        self.tx_hash_cache = Some(cache);
        self
    }

    pub fn with_cors_origins(mut self, origins: Vec<String>) -> Self {
        self.cors_origins = origins;
        self
    }

    pub fn with_rate_limiter(mut self, limiter: Arc<RwLock<RateLimiter>>) -> Self {
        self.rate_limiter = Some(limiter);
        self
    }

    pub fn with_message_whitelist(
        mut self,
        whitelist: Arc<crate::settings::matching_list::MatchingList>,
    ) -> Self {
        self.message_whitelist = Some(whitelist);
        self
    }

    pub fn with_message_blacklist(
        mut self,
        blacklist: Arc<crate::settings::matching_list::MatchingList>,
    ) -> Self {
        self.message_blacklist = Some(blacklist);
        self
    }

    pub fn with_address_blacklist(
        mut self,
        blacklist: Arc<crate::msg::blacklist::AddressBlacklist>,
    ) -> Self {
        self.address_blacklist = Some(blacklist);
        self
    }
}

impl ServerState {
    pub fn router(self) -> Router {
        use tower_http::cors::CorsLayer;

        let cors_headers: Vec<HeaderValue> = self
            .cors_origins
            .iter()
            .filter_map(|origin| {
                origin
                    .parse::<HeaderValue>()
                    .map_err(|e| {
                        warn!(origin, error = %e, "Ignoring invalid CORS origin");
                    })
                    .ok()
            })
            .collect();
        let cors = CorsLayer::new()
            .allow_origin(cors_headers)
            .allow_methods([Method::GET, Method::POST])
            .allow_headers([axum::http::header::CONTENT_TYPE]);

        Router::new()
            .route("/relay", get(health).post(create_relay))
            .layer(cors)
            .with_state(self)
    }
}

// Request/Response types
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub origin_chain: String,
    /// Hex-encoded EVM transaction hash (with or without `0x` prefix).
    pub tx_hash: String,
}

#[derive(Debug, Serialize)]
pub struct RelayResponse {
    pub messages: Vec<MessageInfo>,
}

#[derive(Debug, Serialize)]
pub struct MessageInfo {
    pub message_id: String,
    pub origin: u32,
    pub destination: u32,
    pub nonce: u32,
}

// Error handling
pub enum ServerError {
    TooManyRequests(String),
    InvalidRequest(String),
    NotFound,
    InternalError(String),
    ServiceUnavailable(String),
    RequestTimeout,
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        match self {
            ServerError::TooManyRequests(msg) => {
                (StatusCode::TOO_MANY_REQUESTS, msg).into_response()
            }
            ServerError::InvalidRequest(msg) => (StatusCode::BAD_REQUEST, msg).into_response(),
            ServerError::NotFound => (StatusCode::NOT_FOUND, "Job not found").into_response(),
            ServerError::InternalError(msg) => {
                error!("Internal server error: {}", msg);
                (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error").into_response()
            }
            ServerError::ServiceUnavailable(msg) => {
                (StatusCode::SERVICE_UNAVAILABLE, msg).into_response()
            }
            ServerError::RequestTimeout => {
                (StatusCode::REQUEST_TIMEOUT, "Request timeout").into_response()
            }
        }
    }
}

pub type ServerResult<T> = Result<T, ServerError>;

// Simple global rate limiter
pub struct RateLimiter {
    requests: VecDeque<u64>,
    max_requests: usize,
    window_secs: u64,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            requests: VecDeque::new(),
            max_requests,
            window_secs,
        }
    }

    pub fn check(&mut self) -> bool {
        let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs(),
            Err(e) => {
                error!("System clock is misconfigured (before UNIX_EPOCH): {}. Clearing rate limiter and allowing request.", e);
                self.requests.clear();
                self.requests.push_back(0);
                return true;
            }
        };

        // Timestamps are monotonically increasing so expired entries are always at the front.
        while self
            .requests
            .front()
            .is_some_and(|&t| now.saturating_sub(t) >= self.window_secs)
        {
            self.requests.pop_front();
        }

        if self.requests.len() >= self.max_requests {
            return false;
        }

        self.requests.push_back(now);
        true
    }
}

// GET /relay - Health check
async fn health() -> &'static str {
    "up"
}

// POST /relay - Extract message and insert into database
async fn create_relay(
    State(state): State<ServerState>,
    Json(req): Json<RelayRequest>,
) -> ServerResult<Json<RelayResponse>> {
    info!(
        origin_chain = %req.origin_chain,
        tx_hash = ?req.tx_hash,
        "Received relay request"
    );

    // Rate limit check
    if let Some(limiter) = &state.rate_limiter {
        let mut limiter = limiter.write().await;
        if !limiter.check() {
            state.record_failure("rate_limited");
            return Err(ServerError::TooManyRequests(
                "Rate limit exceeded".to_string(),
            ));
        }
    }

    // Validate request
    if req.origin_chain.is_empty() {
        state.record_failure("invalid_request");
        return Err(ServerError::InvalidRequest(
            "origin_chain cannot be empty".to_string(),
        ));
    }
    if req.origin_chain.len() > 128 {
        state.record_failure("invalid_request");
        return Err(ServerError::InvalidRequest(
            "origin_chain exceeds maximum length of 128 characters".to_string(),
        ));
    }

    // Validate tx_hash length to prevent memory abuse (before cloning into cache)
    // Max EVM tx hash: "0x" + 64 hex chars = 66 chars; 512 is a generous upper bound
    if req.tx_hash.len() > 512 {
        state.record_failure("invalid_request");
        return Err(ServerError::InvalidRequest(
            "tx_hash exceeds maximum length of 512 characters".to_string(),
        ));
    }

    if req.tx_hash.is_empty() {
        state.record_failure("invalid_request");
        return Err(ServerError::InvalidRequest(
            "tx_hash cannot be empty".to_string(),
        ));
    }

    // Reserve the dedup slot before any side-effecting work so concurrent requests
    // for the same (chain, tx_hash) are rejected before touching the send channels.
    // The reservation is held in a TxHashReservation guard that auto-releases on drop
    // (including async cancellation). commit() is called only on the success path.
    let maybe_reservation = if let Some(cache) = &state.tx_hash_cache {
        match cache
            .lock()
            .check_and_insert(req.origin_chain.clone(), req.tx_hash.clone())
        {
            Ok(()) => Some(TxHashReservation::new(
                cache.clone(),
                req.origin_chain.clone(),
                req.tx_hash.clone(),
            )),
            Err(TxHashCacheError::Duplicate) => {
                state.record_failure("duplicate_tx");
                return Err(ServerError::TooManyRequests(
                    "Transaction already submitted recently".to_string(),
                ));
            }
            Err(TxHashCacheError::CacheFull) => {
                state.record_failure("cache_full");
                return Err(ServerError::ServiceUnavailable(
                    "Service temporarily unavailable".to_string(),
                ));
            }
        }
    } else {
        None
    };

    let result = relay_work(&state, &req).await;

    if result.is_ok() {
        if let Some(reservation) = maybe_reservation {
            reservation.commit();
        }
    }
    // On Err (or if this future is dropped/cancelled), `maybe_reservation` drops here
    // and TxHashReservation::drop removes the entry so the client can retry.

    result
}

async fn relay_work(state: &ServerState, req: &RelayRequest) -> ServerResult<Json<RelayResponse>> {
    // 1. Extract message using indexers (with timeout)
    let indexers = &state.indexers;

    let extracted_messages = tokio::time::timeout(
        Duration::from_secs(10),
        crate::relay_api::extract_messages(indexers, &req.origin_chain, &req.tx_hash),
    )
    .await
    .map_err(|_| {
        state.record_failure("timeout");
        ServerError::RequestTimeout
    })?
    .map_err(|e| match e {
        crate::relay_api::ExtractError::Timeout(_) => {
            state.record_failure("timeout");
            ServerError::RequestTimeout
        }
        crate::relay_api::ExtractError::Failed(msg) => {
            state.record_failure("extraction_failed");
            ServerError::InvalidRequest(format!("Failed to extract messages: {msg}"))
        }
    })?;

    const MAX_MESSAGES_PER_TX: usize = 10;
    if extracted_messages.len() > MAX_MESSAGES_PER_TX {
        state.record_failure("too_many_messages");
        return Err(ServerError::InvalidRequest(format!(
            "Transaction contains {} messages, exceeding the limit of {}",
            extracted_messages.len(),
            MAX_MESSAGES_PER_TX
        )));
    }

    info!(
        message_count = extracted_messages.len(),
        origin_chain = %req.origin_chain,
        tx_hash = %req.tx_hash,
        "Successfully extracted messages from transaction"
    );

    // 2. Get shared resources once
    let msg_ctxs = &state.msg_ctxs;

    // 3. Process each message
    let mut processed_messages = Vec::new();

    // Phase 1: validate and prepare all messages before touching the channel or DB.
    // If any message fails here, no side effects have occurred.
    struct ValidatedMessage {
        pending_msg: PendingMessage,
        message_id: H256,
        origin_domain: u32,
        tx_hash: H512,
        destination_domain: u32,
        app_context: Option<String>,
        nonce: u32,
    }

    let mut validated: Vec<ValidatedMessage> = Vec::with_capacity(extracted_messages.len());

    for extracted in &extracted_messages {
        info!(
            message_id = ?extracted.message_id,
            origin = extracted.message.origin,
            destination = extracted.message.destination,
            nonce = extracted.message.nonce,
            "Processing message"
        );

        // Only CCTP V2 messages on EVM chains are eligible for the relay API fast path.
        // Non-EVM chains always produce is_cctp_v2 = false because the trait default
        // returns false and no non-EVM indexer overrides it. Extending the relay API
        // to non-EVM chains requires a chain-specific is_cctp_v2 implementation.
        if !extracted.is_cctp_v2 {
            warn!(message_id = ?extracted.message_id, "Rejecting non-CCTP V2 message");
            state.record_failure("not_cctp_v2");
            return Err(ServerError::InvalidRequest(
                "Only EVM CCTP V2 messages are supported via the relay API".to_string(),
            ));
        }

        // Get message context for (origin, destination)
        let msg_ctx = msg_ctxs
            .get(&(extracted.message.origin, extracted.message.destination))
            .ok_or_else(|| {
                warn!(
                    message_id = ?extracted.message_id,
                    origin = extracted.message.origin,
                    destination = extracted.message.destination,
                    "No message context for origin/destination pair"
                );
                ServerError::InternalError(format!(
                    "No message context for origin {} to destination {}",
                    extracted.message.origin, extracted.message.destination
                ))
            })?;

        // Classify app_context for metrics
        // Use short timeouts to avoid blocking the response
        let recipient_ism = tokio::time::timeout(
            Duration::from_millis(500),
            msg_ctx
                .destination_mailbox
                .recipient_ism(extracted.message.recipient),
        )
        .await
        .map_err(|_| {
            warn!(
                message_id = ?extracted.message_id,
                "Recipient ISM fetch timed out after 500ms, using None for app context"
            );
        })
        .ok()
        .and_then(|result| {
            result
                .map_err(|e| {
                    warn!(
                        message_id = ?extracted.message_id,
                        error = ?e,
                        "Failed to fetch recipient ISM for app context classification, using None"
                    );
                    e
                })
                .ok()
        });

        let app_context = if let Some(ism_address) = recipient_ism {
            tokio::time::timeout(
                Duration::from_millis(500),
                msg_ctx
                    .metadata_builder
                    .app_context_classifier()
                    .get_app_context(&extracted.message, ism_address),
            )
            .await
            .map_err(|_| {
                warn!(
                    message_id = ?extracted.message_id,
                    "App context classification timed out after 500ms, using None"
                );
            })
            .ok()
            .and_then(|result| {
                result
                    .map_err(|e| {
                        warn!(
                            message_id = ?extracted.message_id,
                            error = ?e,
                            "Failed to classify app context, using None"
                        );
                        e
                    })
                    .ok()
            })
            .flatten()
        } else {
            None
        };

        debug!(
            message_id = ?extracted.message_id,
            app_context = ?app_context,
            "Classified message app context"
        );

        // Apply message filtering (whitelist, blacklist, address blacklist)
        if let Some(whitelist) = &state.message_whitelist {
            if !whitelist.msg_matches(&extracted.message, true) {
                warn!(message_id = ?extracted.message_id, "Rejecting message not on whitelist");
                state.record_failure("message_not_whitelisted");
                return Err(ServerError::InvalidRequest(
                    "Message not whitelisted".to_string(),
                ));
            }
        }

        if let Some(blacklist) = &state.message_blacklist {
            if blacklist.msg_matches(&extracted.message, false) {
                warn!(message_id = ?extracted.message_id, "Rejecting blacklisted message");
                state.record_failure("message_blacklisted");
                return Err(ServerError::InvalidRequest(
                    "Message blacklisted".to_string(),
                ));
            }
        }

        if let Some(blacklist) = &state.address_blacklist {
            if let Some(blacklisted_address) =
                blacklist.find_blacklisted_address(&extracted.message)
            {
                warn!(
                    message_id = ?extracted.message_id,
                    address = %hex::encode(blacklisted_address),
                    "Rejecting message involving blacklisted address"
                );
                state.record_failure("message_blacklisted_address");
                return Err(ServerError::InvalidRequest("Message rejected".to_string()));
            }
        }

        // Validate the destination is supported (batch channel existence is the source of truth).
        if !state
            .batch_send_channels
            .contains_key(&extracted.message.destination)
        {
            warn!(
                message_id = ?extracted.message_id,
                destination_domain = extracted.message.destination,
                "No send channel for destination domain"
            );
            return Err(ServerError::InvalidRequest(
                "Unsupported destination".to_string(),
            ));
        }

        // 1 retry: one attempt in the relay API queue, then drop and let the
        // contract indexer re-queue it within seconds via the classical path.
        let pending_msg = PendingMessage::maybe_from_persisted_retries(
            extracted.message.clone(),
            msg_ctx.clone(),
            app_context.clone(),
            1,
        )
        .map(|m| m.with_fail_fast())
        .ok_or_else(|| {
            state.record_failure("retries_exhausted");
            ServerError::InvalidRequest(format!(
                "Message {:?} has exhausted its maximum retries and cannot be re-submitted",
                extracted.message_id
            ))
        })?;

        validated.push(ValidatedMessage {
            pending_msg,
            message_id: extracted.message_id,
            origin_domain: extracted.message.origin,
            tx_hash: extracted.tx_hash,
            destination_domain: extracted.message.destination,
            app_context,
            nonce: extracted.message.nonce,
        });
    }

    // Phase 2: eagerly store IGP payments from the tx receipt for each origin domain.
    //
    // The relayer's gas payment check runs immediately after a message enters the processor
    // queue. Without this step the check races the background `tx_id_indexer_task`, which
    // indexes the same receipt asynchronously and may arrive ~30 s later — causing spurious
    // `GasPaymentNotFound` retries. By fetching and storing the payments here, before any
    // message is enqueued, the race window is closed.
    //
    // Failures are non-fatal: log a warning and proceed. The background indexer still
    // serves as a fallback, so a transient RPC error here doesn't break relay.
    //
    // We deduplicate by (origin_domain, tx_hash) so that a batch with multiple messages
    // from the same tx only triggers one RPC call.
    {
        let mut seen: std::collections::HashSet<(u32, H512)> = std::collections::HashSet::new();
        for v in &validated {
            let key = (v.origin_domain, v.tx_hash);
            if !seen.insert(key) {
                continue;
            }
            let Some(igp_indexer) = state.igp_indexers.get(&v.origin_domain) else {
                continue;
            };
            let Some(db) = state.dbs.get(&v.origin_domain) else {
                continue;
            };
            // 2 s = one honest RPC attempt. EVM's fetch_logs_by_tx_hash uses
            // call_and_retry_indefinitely with a 2 s inter-retry sleep; a timeout
            // longer than 2 s would let the sleep run and add a full retry cycle
            // to every /relay response when the RPC node is slow or flaky.
            // This is best-effort — the background indexer is the fallback.
            match tokio::time::timeout(
                Duration::from_secs(2),
                igp_indexer.fetch_logs_by_tx_hash(v.tx_hash),
            )
            .await
            {
                Err(_) => {
                    warn!(
                        origin_domain = v.origin_domain,
                        tx_hash = ?v.tx_hash,
                        "IGP payment fetch timed out; background indexer will retry"
                    );
                }
                Ok(Err(e)) => {
                    warn!(
                        origin_domain = v.origin_domain,
                        tx_hash = ?v.tx_hash,
                        error = %e,
                        "Failed to fetch IGP payments from relay API receipt; \
                         background indexer will retry"
                    );
                }
                Ok(Ok(payments)) => {
                    if let Err(e) = db.store_logs(&payments).await {
                        warn!(
                            origin_domain = v.origin_domain,
                            tx_hash = ?v.tx_hash,
                            error = %e,
                            "Failed to store IGP payments from relay API receipt; \
                             background indexer will retry"
                        );
                    } else {
                        debug!(
                            origin_domain = v.origin_domain,
                            tx_hash = ?v.tx_hash,
                            count = payments.len(),
                            "Stored IGP payments from relay API receipt"
                        );
                    }
                }
            }
        }
    }

    // Phase 3: send all validated messages.
    //
    // Pre-check: verify every destination batch channel is open before sending anything.
    // UnboundedSender::send() only fails when the receiver (processor) has been
    // dropped. If any channel is already closed we bail here — no messages have
    // entered the queue yet, so the caller's retry is safe and won't double-enqueue.
    for v in &validated {
        let channel_closed = state
            .batch_send_channels
            .get(&v.destination_domain)
            .map_or(true, |ch| ch.is_closed());
        if channel_closed {
            error!(
                message_id = ?v.message_id,
                destination_domain = v.destination_domain,
                "Processor channel closed for destination; aborting before any send"
            );
            state.record_failure("send_failed");
            return Err(ServerError::InternalError(
                "Processor channel closed for destination".to_string(),
            ));
        }
    }

    // Store messageId→txHash for every message, then group by destination and send
    // each group as an atomic batch. Atomic insertion guarantees all siblings from
    // the same origin tx land in the same process_batch cycle so they are submitted
    // together in a single Multicall3 transaction.
    for v in &validated {
        if let Some(db) = state.dbs.get(&v.origin_domain) {
            use hyperlane_base::db::HyperlaneDb;
            if let Err(e) = db.store_dispatched_tx_hash_by_message_id(&v.message_id, &v.tx_hash) {
                warn!(
                    message_id = ?v.message_id,
                    error = %e,
                    "Failed to store tx hash for message — ccip-server will fall back to GraphQL"
                );
            }
        }
    }

    // Group by destination domain and send each group as one Vec.
    let mut by_destination: HashMap<u32, Vec<QueueOperation>> = HashMap::new();
    for v in validated {
        info!(
            message_id = ?v.message_id,
            destination = v.destination_domain,
            app_context = ?v.app_context,
            "Queuing message for atomic batch send"
        );
        processed_messages.push(MessageInfo {
            message_id: format!("{:x}", v.message_id),
            origin: v.origin_domain,
            destination: v.destination_domain,
            nonce: v.nonce,
        });
        by_destination
            .entry(v.destination_domain)
            .or_default()
            .push(Box::new(v.pending_msg) as QueueOperation);
    }

    for (dest_domain, ops) in by_destination {
        let channel = state
            .batch_send_channels
            .get(&dest_domain)
            .expect("channel existence checked above");
        let count = ops.len();
        if let Err(e) = channel.send(ops) {
            error!(
                destination_domain = dest_domain,
                error = %e,
                "Processor channel closed mid-send (race); messages may be double-enqueued on retry"
            );
            state.record_failure("send_failed");
            return Err(ServerError::InternalError(
                "Failed to send messages to processor".to_string(),
            ));
        }
        info!(
            destination_domain = dest_domain,
            count, "Sent atomic batch to processor"
        );
    }

    state.record_success();

    Ok(Json(RelayResponse {
        messages: processed_messages,
    }))
}
