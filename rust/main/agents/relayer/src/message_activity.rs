//! Best-effort sanitized message activity. No network I/O on the delivery path.
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use chrono::Utc;
use parking_lot::Mutex;
use prometheus::IntCounter;
use rand::Rng;
use redact::Secret;
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use serde::Serialize;
use tokio::sync::mpsc;
use tracing::warn;
use uuid::Uuid;

use hyperlane_base::{
    CheckpointObservation, CheckpointObserver, CheckpointSigner, CheckpointUnavailableReason,
    CoreMetrics,
};
use hyperlane_core::{
    ChainCommunicationError, ConfirmReason, HyperlaneMessage, ModuleType, PendingOperationStatus,
    ReprepareReason, SubmissionStage, H160, H256, H512,
};

use crate::msg::metadata::MetadataBuildError;

mod state;

const QUEUE_CAPACITY: usize = 1024;
const BATCH_SIZE: usize = 100;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const WARNING_INTERVAL: Duration = Duration::from_secs(30);

// Intentionally structured data only: no provider errors, RPC URLs, message bodies,
// metadata bytes or signature bytes. Sanitized validator storage URLs are public.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Activity {
    Status {
        status: PendingOperationStatus,
    },
    FirstSeen {
        at_millis: u64,
    },
    Submission {
        stage: SubmissionStage,
    },
    Retry {
        reason: Option<ReprepareReason>,
        retry_count: u32,
        next_attempt_at_millis: Option<u64>,
    },
    Metadata {
        ism: H256,
        error: Option<String>,
    },
    Checkpoint {
        collection_id: String,
        ism: Option<H256>,
        threshold: u8,
        summary: CheckpointSummary,
    },
    TransactionOutcome {
        transaction_id: H512,
        executed: bool,
    },
    ConfirmationError {
        reason: ConfirmReason,
    },
    Progress {
        stage: Stage,
        outcome: Outcome,
    },
    ChainFailure {
        stage: Stage,
        reason: &'static str,
    },
    MerkleLeaf {
        index: u32,
        highest_known: Option<u32>,
    },
    InlineModule {
        kind: &'static str,
        children: usize,
        threshold: Option<u8>,
    },
    MetadataModule {
        ism: H256,
        module_type: ModuleType,
    },
    IsmVerification {
        ism: H256,
        outcome: Outcome,
    },
    Routing {
        ism: H256,
        module: H256,
    },
    Aggregation {
        ism: H256,
        modules: Vec<H256>,
        threshold: u8,
    },
    AggregationSelection {
        indices: Vec<usize>,
    },
    AggregationProgress {
        ism: H256,
        verified: usize,
        threshold: usize,
    },
    ValidatorSet {
        ism: Option<H256>,
        validators: Vec<H256>,
        threshold: u8,
    },
    ValidatorStorage {
        validator: H256,
        states: Vec<ValidatorStorageState>,
        usable: bool,
    },
    OffchainRead {
        ism: H256,
        endpoint: Option<usize>,
        attempt: u32,
        state: OffchainReadState,
        http_status: Option<u16>,
    },
    Filtered {
        reason: FilterReason,
    },
    RetryLimitReached {
        retries: u32,
        limit: u32,
    },
    RecipientNotContract,
    OriginSenderDenied,
    Delivered,
    Dropped,
}

/// Stable activity shapes stored for external consumers.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum StoredActivity {
    /// Complete current message and ISM-tree state.
    Snapshot { state: serde_json::Value },
    /// Message state plus ISM nodes changed since the latest full snapshot.
    SnapshotUpdate { state: serde_json::Value },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Started,
    Succeeded,
    Failed,
    NoEstimate,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Prepare,
    Simulate,
    Submit,
    BuildPayload,
    Confirm,
    ValidatorAnnouncements,
    MerkleLeaf,
    MerkleProof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidatorStorageState {
    NotAnnounced,
    InvalidLocation,
    LocalStorageDisabled,
    LoadFailed,
    ReorgReported,
    ReorgIgnored,
    ReorgCheckFailed,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OffchainReadState {
    LookupFailed,
    OriginTransactionMissing,
    OriginTransactionLookupFailed,
    UrlRejected,
    ClientFailed,
    SigningFailed,
    RequestTimeout,
    RequestFailed,
    BodyReadFailed,
    Pending,
    InvalidResponse,
    Succeeded,
    PendingRetriesExhausted,
    NoEndpoints,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterReason {
    MessageBlacklisted,
    AddressBlacklisted,
    RuntimeDenylisted,
}

/// Fixed codes only: chain errors often wrap URLs, credentials or arbitrary revert text.
pub fn chain_error(error: &ChainCommunicationError) -> &'static str {
    use ChainCommunicationError::*;
    match error {
        HyperlaneProtocolError(_) => "protocol_error",
        ContractError(_) => "contract_call_failed",
        ContractNotFound(_) => "contract_not_found",
        TransactionDropped(_) => "transaction_dropped",
        TransactionTimeout => "transaction_timeout",
        SignerUnavailable => "signer_unavailable",
        HyperlaneSignerError(_) => "signer_error",
        BatchingFailed => "batching_failed",
        BatchIsEmpty => "empty_batch",
        InsufficientFunds { .. } => "insufficient_funds",
        RpcClientError(_) => "rpc_error",
        InvalidRequest { .. } => "invalid_request",
        InvalidReorgPeriod(_) => "invalid_reorg_period",
        SimulationFailed(_) => "simulation_failed",
        TokioJoinError(_) => "task_failed",
        StrOrIntParseError(_)
        | Utf8(_)
        | JsonParseError(_)
        | HexParseError(_)
        | UintParseError(_)
        | FromDecStrError(_)
        | ParseIntError(_)
        | HashParsingError(_)
        | ParseError { .. }
        | PrimitiveTypeError(_)
        | ParseBigDecimalError(_)
        | TryFromIntError(_) => "invalid_response_or_data",
        Other(_) | CustomError(_) | EyreError(_) => "chain_error",
    }
}

/// Explicitly strip every error variant that can contain external text.
/// Exhaustive matching makes new error variants require a privacy decision.
pub fn metadata_error(error: &MetadataBuildError) -> String {
    match error {
        MetadataBuildError::FailedToBuild(_) => "Metadata build failed".to_owned(),
        MetadataBuildError::FastPathError(_) => "Fast path metadata failed".to_owned(),
        MetadataBuildError::Refused(_) => "Validator reported a reorg".to_owned(),
        MetadataBuildError::CouldNotFetch
        | MetadataBuildError::AwaitingValidatorSignatures
        | MetadataBuildError::UnsupportedModuleType(_)
        | MetadataBuildError::MaxIsmDepthExceeded(_)
        | MetadataBuildError::MaxIsmCountReached(_)
        | MetadataBuildError::MaxValidatorCountReached(_)
        | MetadataBuildError::AggregationThresholdNotMet(_) => error.to_string(),
        MetadataBuildError::MerkleRootMismatch {
            root,
            canonical_root,
        } => format!("Merkle root mismatch ({root:#x}, {canonical_root:#x})"),
    }
}

#[derive(Debug, Serialize)]
struct ObservationEvent {
    relayer: H160,
    observed_at: i64,
    message_id: H256,
    origin: u32,
    destination: u32,
    activity: Activity,
    #[serde(skip)]
    node_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct StoredEvent {
    relayer: H160,
    observed_at: i64,
    message_id: H256,
    origin: u32,
    destination: u32,
    activity: StoredActivity,
}

#[derive(Clone, Debug)]
struct ActivityMetrics {
    written: IntCounter,
    dropped: IntCounter,
    failed: IntCounter,
}

impl ActivityMetrics {
    fn new(metrics: &CoreMetrics) -> eyre::Result<Self> {
        let events = metrics.new_int_counter(
            "message_activity_events_total",
            "Diagnostics events written, dropped before enqueue, or lost in a failed write",
            &["outcome"],
        )?;
        Ok(Self {
            written: events.with_label_values(&["written"]),
            dropped: events.with_label_values(&["dropped"]),
            failed: events.with_label_values(&["failed"]),
        })
    }
}

#[derive(Clone, Debug)]
pub struct MessageActivityReporter {
    sender: mpsc::Sender<ObservationEvent>,
    relayer: H160,
    metrics: ActivityMetrics,
}

impl MessageActivityReporter {
    pub fn start(
        url: Secret<String>,
        relayer: H160,
        core_metrics: &CoreMetrics,
        database: hyperlane_base::db::DB,
    ) -> eyre::Result<Self> {
        let metrics = ActivityMetrics::new(core_metrics)?;
        let (sender, receiver) = mpsc::channel(QUEUE_CAPACITY);
        tokio::spawn(write_events(url, receiver, metrics.clone(), Some(database)));
        Ok(Self {
            sender,
            relayer,
            metrics,
        })
    }

    pub fn report(&self, message: &HyperlaneMessage, activity: Activity) {
        self.report_id(message.id(), message.origin, message.destination, activity);
    }

    fn report_id(&self, message_id: H256, origin: u32, destination: u32, activity: Activity) {
        self.report_scoped(message_id, origin, destination, activity, None);
    }

    pub fn report_node(&self, message: &HyperlaneMessage, node_id: &str, activity: Activity) {
        self.report_scoped(
            message.id(),
            message.origin,
            message.destination,
            activity,
            Some(node_id.to_owned()),
        );
    }

    fn report_scoped(
        &self,
        message_id: H256,
        origin: u32,
        destination: u32,
        activity: Activity,
        node_id: Option<String>,
    ) {
        let event = ObservationEvent {
            relayer: self.relayer,
            observed_at: Utc::now().timestamp_millis(),
            message_id,
            origin,
            destination,
            activity,
            node_id,
        };
        if self.sender.try_send(event).is_err() {
            // Never log synchronously on the delivery path, including during an outage.
            self.metrics.dropped.inc();
        }
    }

    pub fn checkpoint_observer(
        &self,
        message: &HyperlaneMessage,
        ism: Option<H256>,
        threshold: u8,
    ) -> Arc<ActivityCheckpointObserver> {
        self.checkpoint_observer_for_node(message, ism, threshold, None)
    }

    pub fn checkpoint_observer_for_node(
        &self,
        message: &HyperlaneMessage,
        ism: Option<H256>,
        threshold: u8,
        node_id: Option<&str>,
    ) -> Arc<ActivityCheckpointObserver> {
        Arc::new(ActivityCheckpointObserver {
            reporter: self.clone(),
            message_id: message.id(),
            origin: message.origin,
            destination: message.destination,
            collection_id: Uuid::new_v4().to_string(),
            ism,
            node_id: node_id.map(str::to_owned),
            threshold,
            summary: Mutex::default(),
            reported: AtomicBool::new(false),
        })
    }
}

// Summaries are scoped to one metadata build. Collections are limited to 50 validators;
// only the latest attempted index is retained, so range walks cannot grow this state.
#[derive(Debug, Default, Serialize)]
pub struct CheckpointSummary {
    index: Option<u32>,
    root: Option<H256>,
    collected: usize,
    signers: Vec<CheckpointSigner>,
    attempts: u64,
    latest_indices: BTreeMap<H160, Option<u32>>,
    discovery_unavailable: BTreeMap<H256, CheckpointUnavailableReason>,
    unavailable: BTreeMap<H256, CheckpointUnavailableReason>,
}

#[derive(Debug)]
pub struct ActivityCheckpointObserver {
    reporter: MessageActivityReporter,
    message_id: H256,
    origin: u32,
    destination: u32,
    collection_id: String,
    ism: Option<H256>,
    threshold: u8,
    summary: Mutex<CheckpointSummary>,
    reported: AtomicBool,
    node_id: Option<String>,
}

impl CheckpointObserver for ActivityCheckpointObserver {
    fn observe(&self, observation: CheckpointObservation) {
        // This observer is private to one collection. The short synchronous guard
        // never spans an await or I/O, including the final queue write.
        let mut summary = self.summary.lock();
        match observation {
            CheckpointObservation::LatestIndex { validator, index } => {
                summary.latest_indices.insert(validator, index);
            }
            CheckpointObservation::Fetching { index } => {
                summary.index = Some(index);
                summary.root = None;
                summary.collected = 0;
                summary.signers.clear();
                summary.unavailable.clear();
                summary.attempts = summary.attempts.saturating_add(1);
            }
            CheckpointObservation::Signature { root, signers, .. } => {
                let collected = signers.len();
                for signer in &signers {
                    summary.unavailable.remove(&signer.validator);
                }
                // Counts belong to a single root; never combine conflicting signatures.
                if collected > summary.collected {
                    summary.root = Some(root);
                    summary.collected = collected;
                    summary.signers = signers;
                }
            }
            CheckpointObservation::Unavailable {
                validator,
                index,
                reason,
            } => {
                match index {
                    Some(_) => summary.unavailable.insert(validator, reason),
                    None => summary.discovery_unavailable.insert(validator, reason),
                };
            }
        }
    }
}

impl ActivityCheckpointObserver {
    pub fn report(&self) {
        self.reported.store(true, Ordering::Relaxed);
        let summary = std::mem::take(&mut *self.summary.lock());
        if summary.attempts == 0
            && summary.latest_indices.is_empty()
            && summary.discovery_unavailable.is_empty()
            && summary.unavailable.is_empty()
        {
            return;
        }
        self.reporter.report_scoped(
            self.message_id,
            self.origin,
            self.destination,
            Activity::Checkpoint {
                collection_id: self.collection_id.clone(),
                ism: self.ism,
                threshold: self.threshold,
                summary,
            },
            self.node_id.clone(),
        );
    }
}

impl Drop for ActivityCheckpointObserver {
    fn drop(&mut self) {
        // Background telemetry may outlive the metadata build's first report.
        // Flush its remaining observations, but keep abandoned collections silent.
        if *self.reported.get_mut() {
            self.report();
        }
    }
}

async fn connect(url: &Secret<String>) -> Result<DatabaseConnection, sea_orm::DbErr> {
    let mut options = ConnectOptions::new(url.expose_secret().clone());
    options
        .max_connections(1)
        .min_connections(0)
        .connect_timeout(WRITE_TIMEOUT)
        .acquire_timeout(WRITE_TIMEOUT)
        .sqlx_logging(false);
    Database::connect(options).await
}

async fn write_events(
    url: Secret<String>,
    mut receiver: mpsc::Receiver<ObservationEvent>,
    metrics: ActivityMetrics,
    database: Option<hyperlane_base::db::DB>,
) {
    let states = state::ActivityState::new(database);
    let mut database = None;
    let mut last_warning: Option<Instant> = None;
    let mut batch = Vec::with_capacity(BATCH_SIZE);
    while receiver.recv_many(&mut batch, BATCH_SIZE).await != 0 {
        let updates = match states.project(&batch).await {
            Ok(updates) => updates,
            Err(_) => {
                metrics.failed.inc_by(batch.len() as u64);
                states.failed(&batch).await;
                if last_warning.is_none_or(|last| last.elapsed() >= WARNING_INTERVAL) {
                    warn!("Could not persist relayer diagnostics snapshot");
                    last_warning = Some(Instant::now());
                }
                batch.clear();
                continue;
            }
        };
        if updates.is_empty() {
            batch.clear();
            continue;
        }
        let result = tokio::time::timeout(WRITE_TIMEOUT, async {
            let db = match &database {
                Some(db) => db,
                None => database.insert(connect(&url).await?),
            };
            insert_events(db, &updates).await
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            // Raw database errors can include connection credentials or SQL values.
            let failure = if result.is_err() {
                "timeout"
            } else {
                "database error"
            };
            metrics.failed.inc_by(updates.len() as u64);
            states.failed(&batch).await;
            if last_warning.is_none_or(|last| last.elapsed() >= WARNING_INTERVAL) {
                warn!(
                    failure,
                    failed_events = metrics.failed.get(),
                    dropped_events = metrics.dropped.get(),
                    "Could not store message activity; dropping batch"
                );
                last_warning = Some(Instant::now());
            }
            // Backoff and logging stay on the background writer. Jitter prevents
            // relayers sharing the database from reconnecting in lockstep.
            let backoff = Duration::from_millis(rand::thread_rng().gen_range(5_000..10_000));
            tokio::time::sleep(backoff).await;
        } else {
            metrics.written.inc_by(updates.len() as u64);
            if states.committed(&updates).await.is_err() {
                warn!("Could not remove completed local diagnostics snapshot");
            }
        }
        batch.clear();
    }
}

async fn insert_events(
    db: &DatabaseConnection,
    events: &[StoredEvent],
) -> Result<(), sea_orm::DbErr> {
    let json = serde_json::to_string(events)
        .map_err(|_| sea_orm::DbErr::Custom("Activity serialization failed".to_owned()))?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"
        INSERT INTO public.message_activity
            (relayer, observed_at, message_id, origin, destination, activity)
        SELECT decode(substr(relayer, 3), 'hex'), to_timestamp(observed_at / 1000.0),
               decode(substr(message_id, 3), 'hex'), origin, destination, activity
        FROM jsonb_to_recordset($1::jsonb) AS event(
            relayer text, observed_at bigint, message_id text,
            origin bigint, destination bigint, activity jsonb)
    "#,
        [json.into()],
    ))
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests;
