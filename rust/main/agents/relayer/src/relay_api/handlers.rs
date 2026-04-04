use axum::{
    extract::State,
    http::{HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use derive_new::new;
use hyperlane_base::db::{HyperlaneDb, HyperlaneRocksDB};
use hyperlane_core::{HyperlaneMessage, Indexer, PendingOperationStatus, QueueOperation};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, error, info, warn};

use crate::msg::pending_message::{MessageContext, PendingMessage};
use crate::relay_api::metrics::RelayApiMetrics;

/// Bounded cache for tracking recently submitted tx hashes to prevent replay attacks
pub struct TxHashCache {
    cache: HashMap<(String, String), Instant>,
    max_entries: usize,
    ttl: Duration,
}

impl TxHashCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            cache: HashMap::new(),
            max_entries,
            ttl: Duration::from_secs(300), // 5 minutes
        }
    }

    /// Check if tx_hash was recently submitted and insert if not
    /// Returns Ok(()) if new, Err with reason if duplicate or cache full
    pub fn check_and_insert(&mut self, chain: String, tx_hash: String) -> Result<(), &'static str> {
        let now = Instant::now();
        let key = (chain, tx_hash);

        // Clean expired entries if cache is getting large (75% threshold)
        if self.cache.len() > self.max_entries.saturating_mul(3) / 4 {
            let ttl = self.ttl;
            self.cache
                .retain(|_, &mut timestamp| now.duration_since(timestamp) < ttl);
        }

        // Check for duplicate within TTL
        if let Some(&timestamp) = self.cache.get(&key) {
            if now.duration_since(timestamp) < self.ttl {
                return Err("Transaction already submitted recently");
            }
        }

        // Enforce max size
        if self.cache.len() >= self.max_entries {
            warn!(
                cache_size = self.cache.len(),
                max_entries = self.max_entries,
                "TX hash cache full, rejecting request"
            );
            return Err("Service temporarily unavailable");
        }

        self.cache.insert(key, now);
        Ok(())
    }
}

#[derive(Clone, new)]
pub struct ServerState {
    #[new(default)]
    rate_limiter: Option<Arc<RwLock<RateLimiter>>>,
    #[new(default)]
    tx_hash_cache: Option<Arc<RwLock<TxHashCache>>>,
    #[new(default)]
    indexers: Option<HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>>,
    #[new(default)]
    dbs: Option<HashMap<u32, HyperlaneRocksDB>>,
    #[new(default)]
    send_channels: Option<HashMap<u32, UnboundedSender<QueueOperation>>>,
    #[new(default)]
    msg_ctxs: Option<HashMap<(u32, u32), Arc<MessageContext>>>,
    #[new(default)]
    metrics: Option<RelayApiMetrics>,
    #[new(default)]
    message_whitelist: Option<Arc<crate::settings::matching_list::MatchingList>>,
    #[new(default)]
    message_blacklist: Option<Arc<crate::settings::matching_list::MatchingList>>,
    #[new(default)]
    address_blacklist: Option<Arc<crate::msg::blacklist::AddressBlacklist>>,
}

impl ServerState {
    pub fn with_tx_hash_cache(mut self, cache: Arc<RwLock<TxHashCache>>) -> Self {
        self.tx_hash_cache = Some(cache);
        self
    }

    pub fn with_indexers(
        mut self,
        indexers: HashMap<String, Arc<dyn Indexer<HyperlaneMessage>>>,
    ) -> Self {
        self.indexers = Some(indexers);
        self
    }

    pub fn with_dbs(mut self, dbs: HashMap<u32, HyperlaneRocksDB>) -> Self {
        self.dbs = Some(dbs);
        self
    }

    pub fn with_send_channels(
        mut self,
        channels: HashMap<u32, UnboundedSender<QueueOperation>>,
    ) -> Self {
        self.send_channels = Some(channels);
        self
    }

    pub fn with_msg_ctxs(mut self, ctxs: HashMap<(u32, u32), Arc<MessageContext>>) -> Self {
        self.msg_ctxs = Some(ctxs);
        self
    }

    pub fn with_metrics(mut self, metrics: RelayApiMetrics) -> Self {
        self.metrics = Some(metrics);
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

        // Restrict CORS to only allow localhost:3000 and nexus.hyperlane.xyz
        let cors = CorsLayer::new()
            .allow_origin([
                "http://localhost:3000"
                    .parse::<HeaderValue>()
                    .expect("Static localhost origin is valid HeaderValue"),
                "https://nexus.hyperlane.xyz"
                    .parse::<HeaderValue>()
                    .expect("Static nexus origin is valid HeaderValue"),
            ])
            .allow_methods([Method::POST])
            .allow_headers([axum::http::header::CONTENT_TYPE]);

        Router::new()
            .route("/relay", post(create_relay))
            .layer(cors)
            .with_state(self)
    }
}

// Request/Response types
#[derive(Debug, Deserialize)]
pub struct RelayRequest {
    pub origin_chain: String,
    pub tx_hash: String, // Protocol-agnostic: hex string for EVM, base58 for Sealevel, etc.
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
    RateLimited,
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
            ServerError::RateLimited => {
                (StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded").into_response()
            }
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
    requests: Vec<u64>,
    max_requests: usize,
    window_secs: u64,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window_secs: u64) -> Self {
        Self {
            requests: Vec::new(),
            max_requests,
            window_secs,
        }
    }

    pub fn check(&mut self) -> bool {
        let now = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs(),
            Err(e) => {
                error!("System clock is misconfigured (before UNIX_EPOCH): {}. Clearing rate limiter and allowing request.", e);
                // If system time is invalid, clear state and allow the request
                self.requests.clear();
                self.requests.push(0);
                return true;
            }
        };

        // Remove requests outside the window (use saturating_sub to prevent underflow)
        self.requests
            .retain(|&t| now.saturating_sub(t) < self.window_secs);

        if self.requests.len() >= self.max_requests {
            return false;
        }

        self.requests.push(now);
        true
    }
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
        let mut limiter = limiter.write().map_err(|e| {
            error!("Rate limiter lock poisoned: {}", e);
            ServerError::InternalError("Rate limiter unavailable".to_string())
        })?;
        if !limiter.check() {
            if let Some(ref metrics) = state.metrics {
                metrics.inc_failure("rate_limited");
            }
            return Err(ServerError::RateLimited);
        }
    }

    // Validate request
    if req.origin_chain.is_empty() {
        if let Some(ref metrics) = state.metrics {
            metrics.inc_failure("invalid_request");
        }
        return Err(ServerError::InvalidRequest(
            "origin_chain cannot be empty".to_string(),
        ));
    }
    if req.origin_chain.len() > 128 {
        if let Some(ref metrics) = state.metrics {
            metrics.inc_failure("invalid_request");
        }
        return Err(ServerError::InvalidRequest(
            "origin_chain exceeds maximum length of 128 characters".to_string(),
        ));
    }

    // Validate tx_hash length to prevent memory abuse (before cloning into cache)
    // Max legitimate tx hash: Radix bech32 (~150 chars), generous limit of 512
    if req.tx_hash.len() > 512 {
        if let Some(ref metrics) = state.metrics {
            metrics.inc_failure("invalid_request");
        }
        return Err(ServerError::InvalidRequest(
            "tx_hash exceeds maximum length of 512 characters".to_string(),
        ));
    }

    if req.tx_hash.is_empty() {
        if let Some(ref metrics) = state.metrics {
            metrics.inc_failure("invalid_request");
        }
        return Err(ServerError::InvalidRequest(
            "tx_hash cannot be empty".to_string(),
        ));
    }

    // Check for duplicate tx_hash submission
    if let Some(cache) = &state.tx_hash_cache {
        let mut cache = cache.write().map_err(|e| {
            error!("Tx hash cache lock poisoned: {}", e);
            ServerError::InternalError("Cache unavailable".to_string())
        })?;
        if let Err(reason) = cache.check_and_insert(req.origin_chain.clone(), req.tx_hash.clone()) {
            if reason.contains("unavailable") {
                if let Some(ref metrics) = state.metrics {
                    metrics.inc_failure("cache_full");
                }
                return Err(ServerError::ServiceUnavailable(reason.to_string()));
            } else {
                if let Some(ref metrics) = state.metrics {
                    metrics.inc_failure("duplicate_tx");
                }
                return Err(ServerError::TooManyRequests(reason.to_string()));
            }
        }
    }

    // 1. Extract message using indexers (with timeout)
    let indexers = state
        .indexers
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Indexers not configured".to_string()))?;

    let extracted_messages = tokio::time::timeout(
        Duration::from_secs(10),
        crate::relay_api::extract_messages(indexers, &req.origin_chain, &req.tx_hash),
    )
    .await
    .map_err(|_| {
        if let Some(ref metrics) = state.metrics {
            metrics.inc_failure("timeout");
        }
        ServerError::RequestTimeout
    })?
    .map_err(|e| {
        if let Some(ref metrics) = state.metrics {
            metrics.inc_failure("extraction_failed");
        }
        ServerError::InvalidRequest(format!("Failed to extract messages: {e}"))
    })?;

    info!(
        message_count = extracted_messages.len(),
        origin_chain = %req.origin_chain,
        tx_hash = %req.tx_hash,
        "Successfully extracted messages from transaction"
    );

    // 2. Get shared resources once
    let dbs = state
        .dbs
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Databases not configured".to_string()))?;

    let msg_ctxs = state
        .msg_ctxs
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Message contexts not configured".to_string()))?;

    let send_channels = state
        .send_channels
        .as_ref()
        .ok_or_else(|| ServerError::InternalError("Send channels not configured".to_string()))?;

    // 3. Process each message
    let mut processed_messages = Vec::new();

    for extracted in extracted_messages {
        info!(
            message_id = ?extracted.message_id,
            origin = extracted.origin_domain,
            destination = extracted.destination_domain,
            nonce = extracted.message.nonce,
            "Processing message"
        );

        // Get message context for (origin, destination)
        let msg_ctx = msg_ctxs
            .get(&(extracted.origin_domain, extracted.destination_domain))
            .ok_or_else(|| {
                ServerError::InternalError(format!(
                    "No message context for origin {} to destination {}",
                    extracted.origin_domain, extracted.destination_domain
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
        // Skip if not whitelisted
        if let Some(whitelist) = &state.message_whitelist {
            if !whitelist.msg_matches(&extracted.message, true) {
                if let Some(ref metrics) = state.metrics {
                    metrics.inc_failure("message_not_whitelisted");
                }
                return Err(ServerError::InvalidRequest(
                    "Message not whitelisted".to_string(),
                ));
            }
        }

        // Skip if message is blacklisted
        if let Some(blacklist) = &state.message_blacklist {
            if blacklist.msg_matches(&extracted.message, false) {
                if let Some(ref metrics) = state.metrics {
                    metrics.inc_failure("message_blacklisted");
                }
                return Err(ServerError::InvalidRequest(
                    "Message blacklisted".to_string(),
                ));
            }
        }

        // Skip if message involves a blacklisted address
        if let Some(blacklist) = &state.address_blacklist {
            if let Some(blacklisted_address) =
                blacklist.find_blacklisted_address(&extracted.message)
            {
                if let Some(ref metrics) = state.metrics {
                    metrics.inc_failure("message_blacklisted_address");
                }
                return Err(ServerError::InvalidRequest(format!(
                    "Message involves blacklisted address: {}",
                    hex::encode(blacklisted_address)
                )));
            }
        }

        // Get send channel for destination
        let send_channel = send_channels
            .get(&extracted.destination_domain)
            .ok_or_else(|| {
                ServerError::InvalidRequest(format!(
                    "No send channel for destination domain {}",
                    extracted.destination_domain
                ))
            })?;

        // Create PendingMessage with classified app_context
        let pending_msg = PendingMessage::new(
            extracted.message.clone(),
            msg_ctx.clone(),
            PendingOperationStatus::FirstPrepareAttempt,
            app_context.clone(),
            0, // Max retries - relay API messages fail fast, no retries
        );

        // CRITICAL: Send to channel FIRST, before persisting to DB
        // This ensures we only persist messages that were successfully queued for processing
        send_channel
            .send(Box::new(pending_msg) as QueueOperation)
            .map_err(|e| {
                error!(
                    message_id = ?extracted.message_id,
                    error = %e,
                    "Failed to send message to processor channel - message will NOT be persisted"
                );
                ServerError::InternalError(format!("Failed to send message to processor: {e}"))
            })?;

        info!(
            message_id = ?extracted.message_id,
            destination = extracted.destination_domain,
            app_context = ?app_context,
            "Successfully sent message to processor channel"
        );

        // Now persist to DB for metrics/audit (after successful channel send)
        let origin_db = dbs.get(&extracted.origin_domain).ok_or_else(|| {
            ServerError::InternalError(format!(
                "No database configured for origin domain {}",
                extracted.origin_domain
            ))
        })?;

        // Store message by ID
        if let Err(e) = origin_db.store_message_by_id(&extracted.message_id, &extracted.message) {
            warn!(
                message_id = ?extracted.message_id,
                error = %e,
                "Failed to persist message to DB (message already in processor queue)"
            );
        }

        // Store nonce -> message_id mapping
        if let Err(e) =
            origin_db.store_message_id_by_nonce(&extracted.message.nonce, &extracted.message_id)
        {
            warn!(
                message_id = ?extracted.message_id,
                error = %e,
                "Failed to persist nonce mapping to DB"
            );
        }

        // Note: We don't update max_seen_nonce here because relay API bypasses indexer.
        // The indexer will update max_seen_nonce when it catches up (even for duplicates).

        // Store dispatched block number (0 = relay API, real block number set by indexer later)
        if let Err(e) =
            origin_db.store_dispatched_block_number_by_nonce(&extracted.message.nonce, &0)
        {
            warn!(
                message_id = ?extracted.message_id,
                error = %e,
                "Failed to persist block number to DB"
            );
        }

        debug!(
            message_id = ?extracted.message_id,
            nonce = extracted.message.nonce,
            "Persisted message to database"
        );

        // Add to response
        processed_messages.push(MessageInfo {
            message_id: format!("{:x}", extracted.message_id),
            origin: extracted.origin_domain,
            destination: extracted.destination_domain,
            nonce: extracted.message.nonce,
        });
    }

    // Track success metric
    if let Some(ref metrics) = state.metrics {
        metrics.inc_success();
    }

    // 4. Return success with all processed messages
    Ok(Json(RelayResponse {
        messages: processed_messages,
    }))
}
