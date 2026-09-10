//! Relayer inputs streamed by scraper-proxy with RPC parity and fallback.

#[cfg(test)]
use hyperlane_base::scraper_websocket::SubscribedStream;
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use eyre::{bail, Context, ContextCompat, Result};
use futures_util::{
    stream::{self, BoxStream},
    StreamExt,
};
use hyperlane_base::{
    broadcast::{BroadcastMpscSender, IndexingNotification},
    db::{DbResult, HyperlaneDb, HyperlaneRocksDB},
    scraper_websocket::{
        format_address as scraper_address, reconnect_after, validate_cutover_freshness,
        EventMessage, GasPaymentCursor as GasPaymentSubscriptionCursor, MerkleEventData,
        RejectedStream, ScraperSession, SequenceCursor, ServerMessage, SessionEvent,
        StreamCursor as SubscriptionCursor, StreamHealth, StreamTimeouts, StringOrNumber,
        SubscribeMessage, SubscribeStream, SubscribedCursor, RETRY_DELAY, RPC_PROBE_TIMEOUT,
    },
    settings::SequenceIndexer,
    CoreMetrics,
};
use hyperlane_core::{
    bytes_to_address, bytes_to_h512, Decode, Encode, HyperlaneMessage, HyperlaneProtocolError,
    Indexed, InterchainGasPayment, LogMeta, MerkleTreeInsertion, H256, H512, U256,
};
use prometheus::{IntCounterVec, IntGaugeVec};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use tokio::{
    sync::{watch, Notify, OwnedSemaphorePermit, Semaphore},
    time::{sleep, timeout, Instant},
};
use tracing::{info, warn};
use url::Url;

const DISPATCH_EVENT_TYPE: &str = "dispatch";
const GAS_PAYMENT_EVENT_TYPE: &str = "gas_payment";
const GAS_PAYMENT_STREAM_CURSOR_VERSION: u32 = 3;
const MERKLE_EVENT_TYPE: &str = "merkle_tree_insertion";
const AUTHORITY_FRESHNESS_CONCURRENCY: usize = 16;
#[cfg(not(test))]
const AUTHORITY_HANDOFF_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(test)]
const AUTHORITY_HANDOFF_TIMEOUT: Duration = Duration::from_millis(50);
const PARITY_READ_CONCURRENCY: usize = 4;
const PARITY_QUEUE_CAPACITY: usize = 256;
#[cfg(not(test))]
const PARITY_READ_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const PARITY_READ_TIMEOUT: Duration = Duration::from_millis(250);
#[cfg(not(test))]
const PARITY_RETRY_DELAY: Duration = Duration::from_secs(1);
#[cfg(test)]
const PARITY_RETRY_DELAY: Duration = Duration::from_millis(10);
#[cfg(not(test))]
const PARITY_RETRY_ATTEMPTS: usize = 300;
#[cfg(test)]
const PARITY_RETRY_ATTEMPTS: usize = 60;
const PARITY_WARN_INTERVAL: Duration = Duration::from_secs(60);
const DUPLICATE_FINGERPRINT_WINDOW: usize = 1_024;
const DISPATCH_CURSOR_PREFIX: &[u8] = b"scraper_websocket_dispatch_cursor";
const GAS_PAYMENT_CURSOR_V1_PREFIX: &[u8] = b"scraper_websocket_gas_payment_stream_cursor_v1";
const GAS_PAYMENT_CURSOR_V2_PREFIX: &[u8] = b"scraper_websocket_gas_payment_stream_cursor_v2";
const GAS_PAYMENT_CURSOR_PREFIX: &[u8] = b"scraper_websocket_gas_payment_stream_cursor_v3";
const GAS_PAYMENT_DEGRADED_PREFIX: &[u8] = b"scraper_websocket_gas_payment_degraded_v3";
const MERKLE_CURSOR_PREFIX: &[u8] = b"scraper_websocket_merkle_cursor";
// V1 poison keys are intentionally retained in RocksDB. V2 starts a clean
// parity epoch after fixing the first deployment's known false failures.
const PARITY_UNHEALTHY_PREFIX: &[u8] = b"scraper_websocket_parity_unhealthy_v2";
#[cfg(test)]
const PARITY_UNHEALTHY_V1_PREFIX: &[u8] = b"scraper_websocket_parity_unhealthy";

#[cfg_attr(test, mockall::automock)]
trait ParityDatabase: Send + Sync {
    fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>>;
    fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>>;
    fn retrieve_dispatched_tx_hash_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<H512>>;
    fn retrieve_merkle_tree_insertion_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<MerkleTreeInsertion>>;
    fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<u64>>;
}

impl ParityDatabase for HyperlaneRocksDB {
    fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>> {
        HyperlaneDb::retrieve_message_by_nonce(self, nonce)
    }

    fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>> {
        HyperlaneDb::retrieve_dispatched_block_number_by_nonce(self, nonce)
    }

    fn retrieve_dispatched_tx_hash_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<H512>> {
        HyperlaneDb::retrieve_dispatched_tx_hash_by_message_id(self, message_id)
    }

    fn retrieve_merkle_tree_insertion_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<MerkleTreeInsertion>> {
        HyperlaneDb::retrieve_merkle_tree_insertion_by_leaf_index(self, leaf_index)
    }

    fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<u64>> {
        HyperlaneDb::retrieve_merkle_tree_insertion_block_number_by_leaf_index(self, leaf_index)
    }
}

#[derive(Clone)]
pub(crate) struct ScraperSource {
    broadcaster: Option<BroadcastMpscSender<IndexingNotification>>,
    chain: String,
    cursor_db: HyperlaneRocksDB,
    domain: u32,
    interchain_gas_paymaster: H256,
    mailbox: H256,
    merkle_tree_hook: H256,
    database: Arc<dyn ParityDatabase>,
    freshness_indexer: Option<SequenceIndexer<HyperlaneMessage>>,
    merkle_freshness_indexer: Option<SequenceIndexer<MerkleTreeInsertion>>,
}

impl ScraperSource {
    pub(crate) fn new(
        chain: String,
        domain: u32,
        mailbox: H256,
        interchain_gas_paymaster: H256,
        merkle_tree_hook: H256,
        database: HyperlaneRocksDB,
    ) -> Self {
        Self {
            broadcaster: None,
            chain,
            cursor_db: database.clone(),
            domain,
            interchain_gas_paymaster,
            mailbox,
            merkle_tree_hook,
            database: Arc::new(database),
            freshness_indexer: None,
            merkle_freshness_indexer: None,
        }
    }

    pub(crate) fn with_broadcaster(
        mut self,
        broadcaster: Option<BroadcastMpscSender<IndexingNotification>>,
    ) -> Self {
        self.broadcaster = broadcaster;
        self
    }

    pub(crate) fn with_freshness_indexer(
        mut self,
        indexer: SequenceIndexer<HyperlaneMessage>,
    ) -> Self {
        self.freshness_indexer = Some(indexer);
        self
    }

    pub(crate) fn with_merkle_freshness_indexer(
        mut self,
        indexer: SequenceIndexer<MerkleTreeInsertion>,
    ) -> Self {
        self.merkle_freshness_indexer = Some(indexer);
        self
    }

    #[cfg(test)]
    fn with_database(
        chain: String,
        domain: u32,
        mailbox: H256,
        interchain_gas_paymaster: H256,
        merkle_tree_hook: H256,
        database: Arc<dyn ParityDatabase>,
    ) -> Self {
        let tempdir = tempfile::tempdir().expect("temporary scraper cursor DB");
        let db =
            hyperlane_base::db::test_utils::setup_db(tempdir.path().to_string_lossy().into_owned());
        std::mem::forget(tempdir);
        Self {
            broadcaster: None,
            chain,
            cursor_db: HyperlaneRocksDB::new(
                &hyperlane_core::HyperlaneDomain::new_test_domain("scraper-parity-cursor"),
                db,
            ),
            domain,
            interchain_gas_paymaster,
            mailbox,
            merkle_tree_hook,
            database,
            freshness_indexer: None,
            merkle_freshness_indexer: None,
        }
    }

    fn address(&self, kind: EventKind) -> H256 {
        match kind {
            EventKind::Dispatch => self.mailbox,
            EventKind::GasPayment => self.interchain_gas_paymaster,
            EventKind::MerkleTreeInsertion => self.merkle_tree_hook,
        }
    }

    fn cursor(&self, kind: EventKind) -> Result<Option<u32>> {
        self.cursor_db
            .retrieve_value_by_key(kind.cursor_prefix(), &self.address(kind))
            .context("Reading durable scraper WebSocket cursor")
    }

    fn store_cursor(&self, kind: EventKind, sequence: u32) -> Result<()> {
        if self.cursor(kind)?.is_some_and(|stored| stored >= sequence) {
            return Ok(());
        }
        self.cursor_db
            .store_value_by_key(kind.cursor_prefix(), &self.address(kind), &sequence)
            .context("Storing durable scraper WebSocket cursor")
    }

    fn parity_unhealthy(&self, kind: EventKind) -> Result<bool> {
        Ok(self
            .cursor_db
            .retrieve_value_by_key(PARITY_UNHEALTHY_PREFIX, &self.address(kind))?
            .unwrap_or(false))
    }

    fn store_parity_unhealthy(&self, kind: EventKind) -> Result<()> {
        self.cursor_db
            .store_value_by_key(PARITY_UNHEALTHY_PREFIX, &self.address(kind), &true)
            .context("Storing durable scraper parity health")
    }

    fn gas_payment_cursor(&self) -> Result<Option<DurableGasPaymentCursor>> {
        self.cursor_db
            .retrieve_value_by_key(GAS_PAYMENT_CURSOR_PREFIX, &self.interchain_gas_paymaster)
            .context("Reading durable scraper gas payment cursor")
    }

    fn gas_payment_v2_cursor(&self) -> Result<Option<DurableGasPaymentCursor>> {
        self.cursor_db
            .retrieve_value_by_key(GAS_PAYMENT_CURSOR_V2_PREFIX, &self.interchain_gas_paymaster)
            .context("Reading v2 durable scraper gas payment cursor")
    }

    fn gas_payment_v1_cursor(&self) -> Result<Option<LegacyDurableGasPaymentCursor>> {
        self.cursor_db
            .retrieve_value_by_key(GAS_PAYMENT_CURSOR_V1_PREFIX, &self.interchain_gas_paymaster)
            .context("Reading legacy durable scraper gas payment cursor")
    }

    #[cfg(test)]
    fn store_gas_payment_v1_cursor(&self, cursor: &LegacyDurableGasPaymentCursor) -> Result<()> {
        self.cursor_db
            .store_value_by_key(
                GAS_PAYMENT_CURSOR_V1_PREFIX,
                &self.interchain_gas_paymaster,
                cursor,
            )
            .context("Storing legacy durable scraper gas payment cursor")
    }

    #[cfg(test)]
    fn store_gas_payment_v2_cursor(&self, cursor: &DurableGasPaymentCursor) -> Result<()> {
        self.cursor_db
            .store_value_by_key(
                GAS_PAYMENT_CURSOR_V2_PREFIX,
                &self.interchain_gas_paymaster,
                cursor,
            )
            .context("Storing v2 durable scraper gas payment cursor")
    }

    fn store_gas_payment_cursor(&self, cursor: &DurableGasPaymentCursor) -> Result<()> {
        if let Some(stored) = self.gas_payment_cursor()? {
            if stored.stream_cursor > cursor.stream_cursor {
                bail!("Durable scraper gas payment cursor moved backwards");
            }
            if stored.stream_cursor == cursor.stream_cursor {
                if stored.fingerprint == cursor.fingerprint || cursor.fingerprint.is_none() {
                    return Ok(());
                }
                if stored.fingerprint.is_some() {
                    bail!("Conflicting durable scraper gas payment cursor fingerprint");
                }
            }
        }
        self.cursor_db
            .store_value_by_key(
                GAS_PAYMENT_CURSOR_PREFIX,
                &self.interchain_gas_paymaster,
                cursor,
            )
            .context("Storing durable scraper gas payment cursor")
    }

    fn gas_payment_degraded(&self) -> Result<bool> {
        Ok(self
            .cursor_db
            .retrieve_value_by_key(GAS_PAYMENT_DEGRADED_PREFIX, &self.interchain_gas_paymaster)?
            .unwrap_or(false))
    }

    fn store_gas_payment_degraded(&self) -> Result<()> {
        self.cursor_db
            .store_value_by_key(
                GAS_PAYMENT_DEGRADED_PREFIX,
                &self.interchain_gas_paymaster,
                &true,
            )
            .context("Storing durable scraper gas payment degradation")
    }

    fn store_sequenced_event(&self, input: &ParityInput) -> Result<Option<IndexingNotification>> {
        match input.compare(self.database.as_ref())? {
            ParityResult::Match => {
                if let ParityInput::MerkleTreeInsertion {
                    block_number,
                    insertion,
                } = input
                {
                    self.cursor_db
                        .process_tree_insertion(insertion, *block_number)?;
                }
                return Ok(None);
            }
            ParityResult::Conflict => bail!("Scraper event conflicts with local RPC data"),
            ParityResult::Missing => {}
        }
        let notification = match input {
            ParityInput::Dispatch {
                block_number,
                message,
                transaction_id,
            } => {
                self.cursor_db.store_message(message, *block_number)?;
                if HyperlaneDb::retrieve_dispatched_block_number_by_nonce(
                    &self.cursor_db,
                    &message.nonce,
                )?
                .is_none()
                {
                    self.cursor_db
                        .store_dispatched_block_number_by_nonce(&message.nonce, block_number)?;
                }
                if HyperlaneDb::retrieve_dispatched_tx_hash_by_message_id(
                    &self.cursor_db,
                    &message.id(),
                )?
                .is_none()
                {
                    self.cursor_db
                        .store_dispatched_tx_hash_by_message_id(&message.id(), transaction_id)?;
                }
                Some(IndexingNotification {
                    tx_id: *transaction_id,
                    sequences: vec![Some(message.nonce)],
                })
            }
            ParityInput::MerkleTreeInsertion {
                block_number,
                insertion,
            } => {
                self.cursor_db
                    .process_tree_insertion(insertion, *block_number)?;
                if HyperlaneDb::retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                    &self.cursor_db,
                    &insertion.index(),
                )?
                .is_none()
                {
                    self.cursor_db
                        .store_merkle_tree_insertion_block_number_by_leaf_index(
                            &insertion.index(),
                            block_number,
                        )?;
                }
                None
            }
        };
        match input.compare(self.database.as_ref())? {
            ParityResult::Match => Ok(notification),
            ParityResult::Conflict => bail!("Stored scraper event conflicts with local data"),
            ParityResult::Missing => bail!("Stored scraper event remains incomplete"),
        }
    }

    fn store_gas_payment(&self, input: &GasPaymentInput) -> Result<()> {
        self.cursor_db
            .process_indexed_gas_payment(input.payment, &input.meta)
            .context("Storing scraper gas payment")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum EventKind {
    Dispatch,
    GasPayment,
    MerkleTreeInsertion,
}

impl EventKind {
    fn label(self) -> &'static str {
        match self {
            Self::Dispatch => DISPATCH_EVENT_TYPE,
            Self::GasPayment => GAS_PAYMENT_EVENT_TYPE,
            Self::MerkleTreeInsertion => MERKLE_EVENT_TYPE,
        }
    }

    fn cursor_prefix(self) -> &'static [u8] {
        match self {
            Self::Dispatch => DISPATCH_CURSOR_PREFIX,
            Self::GasPayment => unreachable!("gas payments use row ID cursors"),
            Self::MerkleTreeInsertion => MERKLE_CURSOR_PREFIX,
        }
    }

    fn from_label(label: &str) -> Result<Self> {
        match label {
            DISPATCH_EVENT_TYPE => Ok(Self::Dispatch),
            MERKLE_EVENT_TYPE => Ok(Self::MerkleTreeInsertion),
            _ => bail!("Unexpected scraper event type {label}"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct SequencedReplaySource {
    dispatch_floor: Option<u32>,
    merkle_floor: Option<u32>,
}

impl SequencedReplaySource {
    fn floor(self, kind: EventKind) -> Option<u32> {
        match kind {
            EventKind::Dispatch => self.dispatch_floor,
            EventKind::GasPayment => None,
            EventKind::MerkleTreeInsertion => self.merkle_floor,
        }
    }
}

#[derive(Debug, Default)]
struct SequencedReplayPlan {
    sources: HashMap<u32, SequencedReplaySource>,
}

impl SequencedReplayPlan {
    fn load(sources: &HashMap<u32, ScraperSource>) -> Result<Self> {
        let mut plan = Self::default();
        for source in sources.values() {
            let dispatch_floor = source.cursor(EventKind::Dispatch)?;
            let merkle_floor = source.cursor(EventKind::MerkleTreeInsertion)?;
            plan.sources.insert(
                source.domain,
                SequencedReplaySource {
                    dispatch_floor,
                    merkle_floor,
                },
            );
        }
        Ok(plan)
    }

    fn source(&self, domain: u32) -> Result<SequencedReplaySource> {
        self.sources
            .get(&domain)
            .copied()
            .context("Scraper replay plan omitted configured source")
    }
}

#[derive(Debug, Eq, PartialEq)]
enum SequenceResult {
    Accepted,
    Duplicate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ParityResult {
    Match,
    Missing,
    Conflict,
}

impl ParityResult {
    fn label(self) -> &'static str {
        match self {
            Self::Match => "match",
            Self::Missing => "missing",
            Self::Conflict => "conflict",
        }
    }
}

#[derive(Debug)]
struct ValidatedEvent {
    gas_payment: Option<GasPaymentInput>,
    kind: EventKind,
    parity: Option<ParityInput>,
    sequence: Option<u32>,
    sequence_result: SequenceResult,
}

#[derive(Debug, Default)]
struct StagedParity {
    events: HashMap<u32, VecDeque<StagedParityEvent>>,
    len: usize,
}

#[derive(Debug)]
struct StagedParityEvent {
    kind: EventKind,
    parity: ParityInput,
    sequence: u32,
}

impl StagedParity {
    fn push(&mut self, domain: u32, event: ValidatedEvent) -> Result<()> {
        if self.len >= PARITY_QUEUE_CAPACITY {
            bail!("Fresh scraper parity staging exceeded {PARITY_QUEUE_CAPACITY} events");
        }
        let event = StagedParityEvent {
            kind: event.kind,
            parity: event
                .parity
                .context("Sequenced parity event omitted its parity input")?,
            sequence: event
                .sequence
                .context("Sequenced parity event omitted its wire sequence")?,
        };
        self.events.entry(domain).or_default().push_back(event);
        self.len = self
            .len
            .checked_add(1)
            .context("Fresh scraper parity staging length overflowed")?;
        Ok(())
    }

    fn drain_ready(
        &mut self,
        plan: &SequencedReplayPlan,
        caught_up: &HashMap<(u32, EventKind), i64>,
        state: &StreamState,
        domain: u32,
    ) -> Result<VecDeque<StagedParityEvent>> {
        if !self.events.contains_key(&domain) {
            return Ok(VecDeque::new());
        }
        let readiness = self
            .events
            .get(&domain)
            .expect("checked staged parity domain exists")
            .iter()
            .map(|event| {
                sequenced_persistence_ready(
                    plan,
                    caught_up,
                    state,
                    domain,
                    event.kind,
                    event.sequence,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        let events = self
            .events
            .remove(&domain)
            .expect("checked staged parity domain exists");
        let mut ready = VecDeque::new();
        let mut retained = VecDeque::new();
        for (event, ready_for_persistence) in events.into_iter().zip(readiness) {
            if ready_for_persistence {
                ready.push_back(event);
            } else {
                retained.push_back(event);
            }
        }
        self.len = self
            .len
            .checked_sub(ready.len())
            .context("Fresh scraper parity staging length underflowed")?;
        if !retained.is_empty() {
            self.events.insert(domain, retained);
        }
        Ok(ready)
    }

    fn drain_all(&mut self) -> impl Iterator<Item = (u32, StagedParityEvent)> + '_ {
        self.len = 0;
        self.events
            .drain()
            .flat_map(|(domain, events)| events.into_iter().map(move |event| (domain, event)))
    }
}

#[derive(Clone, Debug)]
enum ParityInput {
    Dispatch {
        block_number: u64,
        message: HyperlaneMessage,
        transaction_id: H512,
    },
    MerkleTreeInsertion {
        block_number: u64,
        insertion: MerkleTreeInsertion,
    },
}

#[derive(Clone, Debug)]
struct GasPaymentInput {
    cursor: DurableGasPaymentCursor,
    meta: LogMeta,
    payment: Indexed<InterchainGasPayment>,
}

impl ParityInput {
    fn compare(&self, database: &dyn ParityDatabase) -> Result<ParityResult> {
        match self {
            Self::Dispatch {
                block_number,
                message,
                transaction_id,
            } => {
                let local_message = database
                    .retrieve_message_by_nonce(message.nonce)
                    .context("Reading RPC-indexed dispatch message")?;
                let local_block_number = database
                    .retrieve_dispatched_block_number_by_nonce(&message.nonce)
                    .context("Reading RPC-indexed dispatch block number")?;
                let local_transaction_id = database
                    .retrieve_dispatched_tx_hash_by_message_id(&message.id())
                    .context("Reading RPC-indexed dispatch transaction ID")?;
                // Sealevel's basic log metadata stores zero when the relayer's
                // advanced transaction lookup is disabled. Keep requiring the
                // entry, but only compare transaction IDs when one is known.
                let transaction_id_conflicts = local_transaction_id
                    .is_some_and(|local| local != H512::zero() && local != *transaction_id);
                if local_message.as_ref().is_some_and(|local| local != message)
                    || local_block_number.is_some_and(|local| local != *block_number)
                    || transaction_id_conflicts
                {
                    return Ok(ParityResult::Conflict);
                }
                if local_message.is_none()
                    || local_block_number.is_none()
                    || local_transaction_id.is_none()
                {
                    return Ok(ParityResult::Missing);
                }
                Ok(ParityResult::Match)
            }
            Self::MerkleTreeInsertion {
                block_number,
                insertion,
            } => {
                let local_insertion = database
                    .retrieve_merkle_tree_insertion_by_leaf_index(&insertion.index())
                    .context("Reading RPC-indexed Merkle tree insertion")?;
                let local_block_number = database
                    .retrieve_merkle_tree_insertion_block_number_by_leaf_index(&insertion.index())
                    .context("Reading RPC-indexed Merkle insertion block number")?;
                if local_insertion
                    .as_ref()
                    .is_some_and(|local| local != insertion)
                    || local_block_number.is_some_and(|local| local != *block_number)
                {
                    return Ok(ParityResult::Conflict);
                }
                if local_insertion.is_none() || local_block_number.is_none() {
                    return Ok(ParityResult::Missing);
                }
                Ok(ParityResult::Match)
            }
        }
    }
}

type EventFingerprint = H256;

#[derive(Debug)]
struct StreamCursor {
    fingerprints: BTreeMap<u32, EventFingerprint>,
    first_sequence: Option<u32>,
    next_sequence: u32,
}

impl StreamCursor {
    fn from_durable_sequence(sequence: u32) -> Self {
        Self {
            fingerprints: BTreeMap::new(),
            first_sequence: None,
            next_sequence: sequence,
        }
    }

    fn from_after_sequence(sequence: u32) -> Result<Self> {
        Ok(Self {
            fingerprints: BTreeMap::new(),
            first_sequence: None,
            next_sequence: sequence
                .checked_add(1)
                .context("Scraper event sequence exhausted")?,
        })
    }

    fn new(sequence: u32, fingerprint: EventFingerprint) -> Result<Self> {
        let mut fingerprints = BTreeMap::new();
        fingerprints.insert(sequence, fingerprint);
        Ok(Self {
            fingerprints,
            first_sequence: Some(sequence),
            next_sequence: sequence
                .checked_add(1)
                .context("Scraper event sequence exhausted")?,
        })
    }

    fn check(&self, sequence: u32, fingerprint: EventFingerprint) -> Result<SequenceResult> {
        if sequence < self.next_sequence {
            return match self.fingerprints.get(&sequence) {
                Some(previous) if previous == &fingerprint => Ok(SequenceResult::Duplicate),
                Some(_) => bail!("Conflicting scraper event at sequence {sequence}"),
                None => bail!(
                    "Scraper event sequence {sequence} is older than the retained duplicate window"
                ),
            };
        }
        if sequence > self.next_sequence {
            return Err(StreamGap {
                expected: u64::from(self.next_sequence),
                received: u64::from(sequence),
            }
            .into());
        }

        self.next_sequence
            .checked_add(1)
            .context("Scraper event sequence exhausted")?;

        Ok(SequenceResult::Accepted)
    }

    fn accept(&mut self, sequence: u32, fingerprint: EventFingerprint) -> Result<()> {
        self.first_sequence.get_or_insert(sequence);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .context("Scraper event sequence exhausted")?;
        self.fingerprints.insert(sequence, fingerprint);
        while self.fingerprints.len() > DUPLICATE_FINGERPRINT_WINDOW {
            self.fingerprints.pop_first();
        }
        Ok(())
    }

    fn latest_sequence(&self) -> Result<u32> {
        self.next_sequence
            .checked_sub(1)
            .context("Scraper cursor has no accepted sequence")
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Scraper stream gap: expected sequence {expected}, received {received}")]
struct StreamGap {
    expected: u64,
    received: u64,
}

#[derive(Debug, Default)]
struct StreamState {
    cursors: HashMap<(u32, EventKind), StreamCursor>,
    gas_payment_degraded: HashSet<u32>,
    gas_payment_v1_rows: HashMap<u32, LegacyDurableGasPaymentCursor>,
    gas_payment_v2_rows: HashMap<u32, DurableGasPaymentCursor>,
    gas_payment_rows: HashMap<u32, DurableGasPaymentCursor>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct LegacyDurableGasPaymentCursor {
    fingerprint: Option<H256>,
    stream_cursor: u64,
}

impl Encode for LegacyDurableGasPaymentCursor {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = self.fingerprint.is_some().write_to(writer)?;
        if let Some(fingerprint) = self.fingerprint {
            written = written.saturating_add(fingerprint.write_to(writer)?);
        }
        written = written.saturating_add(self.stream_cursor.write_to(writer)?);
        Ok(written)
    }
}

impl Decode for LegacyDurableGasPaymentCursor {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let fingerprint = bool::read_from(reader)?
            .then(|| H256::read_from(reader))
            .transpose()?;
        let stream_cursor = u64::read_from(reader)?;
        Ok(Self {
            fingerprint,
            stream_cursor,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct DurableGasPaymentCursor {
    fingerprint: Option<H256>,
    legacy_max_stream_cursor: u64,
    stream_cursor: u64,
}

impl Encode for DurableGasPaymentCursor {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = self.fingerprint.is_some().write_to(writer)?;
        if let Some(fingerprint) = self.fingerprint {
            written = written.saturating_add(fingerprint.write_to(writer)?);
        }
        written = written.saturating_add(self.legacy_max_stream_cursor.write_to(writer)?);
        written = written.saturating_add(self.stream_cursor.write_to(writer)?);
        Ok(written)
    }
}

impl Decode for DurableGasPaymentCursor {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let fingerprint = bool::read_from(reader)?
            .then(|| H256::read_from(reader))
            .transpose()?;
        let legacy_max_stream_cursor = u64::read_from(reader)?;
        let stream_cursor = u64::read_from(reader)?;
        Ok(Self {
            fingerprint,
            legacy_max_stream_cursor,
            stream_cursor,
        })
    }
}

impl StreamState {
    fn load_gas_payment(sources: &HashMap<u32, ScraperSource>) -> Result<Self> {
        let mut state = Self::default();
        for source in sources.values() {
            if source.gas_payment_degraded()? {
                state.gas_payment_degraded.insert(source.domain);
            }
            if let Some(cursor) = source.gas_payment_cursor()? {
                state.gas_payment_rows.insert(source.domain, cursor);
            } else if let Some(cursor) = source.gas_payment_v2_cursor()? {
                state.gas_payment_v2_rows.insert(source.domain, cursor);
            } else if let Some(cursor) = source.gas_payment_v1_cursor()? {
                state.gas_payment_v1_rows.insert(source.domain, cursor);
            }
        }
        Ok(state)
    }

    fn reset_sequenced(&mut self, plan: &SequencedReplayPlan) {
        self.cursors.clear();
        for (domain, source) in &plan.sources {
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                if let Some(sequence) = source.floor(kind) {
                    self.cursors.insert(
                        (*domain, kind),
                        StreamCursor::from_durable_sequence(sequence),
                    );
                }
            }
        }
    }

    fn gas_payment_resume_cursor(&self, domain: u32) -> Option<u64> {
        self.gas_payment_rows
            .get(&domain)
            .map(|cursor| cursor.stream_cursor)
            .or_else(|| {
                self.gas_payment_v2_rows
                    .get(&domain)
                    .map(|cursor| cursor.stream_cursor)
            })
            .or_else(|| {
                self.gas_payment_v1_rows
                    .get(&domain)
                    .map(|cursor| cursor.stream_cursor)
            })
    }

    fn set_baseline(&mut self, domain: u32, kind: EventKind, sequence: i64) -> Result<()> {
        if self.cursors.contains_key(&(domain, kind)) || sequence < 0 {
            return Ok(());
        }
        let sequence: u32 = sequence
            .try_into()
            .context("Scraper caught-up sequence exceeds u32")?;
        self.cursors
            .insert((domain, kind), StreamCursor::from_after_sequence(sequence)?);
        Ok(())
    }

    fn validate_fresh_baseline(&self, domain: u32, kind: EventKind, sequence: i64) -> Result<()> {
        let Some(first) = self
            .cursors
            .get(&(domain, kind))
            .and_then(|cursor| cursor.first_sequence)
        else {
            return Ok(());
        };
        let expected: u32 = sequence
            .checked_add(1)
            .context("Scraper caught-up sequence exhausted")?
            .try_into()
            .context("Scraper caught-up sequence exceeds u32")?;
        if first != expected {
            bail!(
                "Fresh {} scraper stream started at sequence {first}, expected {expected} after caught-up baseline {sequence}",
                kind.label()
            );
        }
        Ok(())
    }

    #[cfg(test)]
    fn latest_sequence(&self, domain: u32, kind: EventKind) -> Result<u32> {
        self.cursors
            .get(&(domain, kind))
            .context("Validated scraper stream has no cursor")?
            .latest_sequence()
    }

    fn validate(
        &mut self,
        event: EventMessage<serde_json::Value>,
        sources: &HashMap<u32, ScraperSource>,
    ) -> Result<ValidatedEvent> {
        let source = sources
            .get(&event.domain)
            .with_context(|| format!("Unexpected scraper event domain {}", event.domain))?;
        if event.event_type == GAS_PAYMENT_EVENT_TYPE {
            return self.validate_gas_payment(event, source);
        }
        if event.row_id.is_some() || event.stream_cursor.is_some() {
            bail!("Sequenced scraper event unexpectedly included a row/stream cursor");
        }
        let sequence = event
            .sequence
            .as_deref()
            .context("Sequenced scraper event omitted sequence")?
            .parse::<u32>()
            .context("Invalid scraper event sequence")?;

        let (kind, fingerprint, parity) = match event.event_type.as_str() {
            DISPATCH_EVENT_TYPE => {
                let data: DispatchEventData =
                    serde_json::from_value(event.data).context("Invalid dispatch event payload")?;
                if data.origin_domain != event.domain {
                    bail!("Dispatch payload domain does not match event envelope");
                }
                let origin_mailbox = parse_address(&data.origin_mailbox)?;
                if origin_mailbox != source.mailbox {
                    bail!("Dispatch event mailbox does not match configured mailbox");
                }
                let nonce = data.nonce.as_u32("dispatch nonce")?;
                if nonce != sequence {
                    bail!("Dispatch event nonce does not match stream sequence");
                }
                let body = parse_hex(
                    data.msg_body
                        .as_deref()
                        .context("Dispatch event omitted message body")?,
                )?;
                let message = HyperlaneMessage {
                    version: 3,
                    nonce,
                    origin: data.origin_domain,
                    sender: parse_address(&data.sender)?,
                    destination: data.destination_domain,
                    recipient: parse_address(&data.recipient)?,
                    body,
                };
                let message_id = parse_h256(&data.msg_id, "dispatch message ID")?;
                if message.id() != message_id {
                    bail!("Dispatch message ID does not match reconstructed message");
                }
                if data.time_created.is_empty() {
                    bail!("Dispatch event omitted creation time");
                }
                let origin_block_hash = parse_h256(&data.origin_block_hash, "origin block hash")?;
                let origin_block_height = data.origin_block_height.as_u64("origin block height")?;
                let origin_tx_hash = parse_h512(&data.origin_tx_hash)?;
                let row_id = data.id.as_u64("dispatch row ID")?;
                let row_id_bytes = row_id.to_be_bytes();
                let origin_block_height_bytes = origin_block_height.to_be_bytes();
                let fingerprint = event_fingerprint(&[
                    b"dispatch",
                    &row_id_bytes,
                    message_id.as_ref(),
                    origin_block_hash.as_ref(),
                    &origin_block_height_bytes,
                    origin_mailbox.as_ref(),
                    origin_tx_hash.as_ref(),
                    data.time_created.as_bytes(),
                ]);
                (
                    EventKind::Dispatch,
                    fingerprint,
                    ParityInput::Dispatch {
                        block_number: origin_block_height,
                        message,
                        transaction_id: origin_tx_hash,
                    },
                )
            }
            MERKLE_EVENT_TYPE => {
                let data: MerkleEventData = serde_json::from_value(event.data)
                    .context("Invalid Merkle tree insertion payload")?;
                let (insertion, block_number) =
                    data.decode(event.domain, source.merkle_tree_hook, sequence)?;
                let block_number_bytes = block_number.to_be_bytes();
                (
                    EventKind::MerkleTreeInsertion,
                    event_fingerprint(&[
                        b"merkle_tree_insertion",
                        &block_number_bytes,
                        source.merkle_tree_hook.as_ref(),
                        insertion.message_id().as_ref(),
                    ]),
                    ParityInput::MerkleTreeInsertion {
                        block_number,
                        insertion,
                    },
                )
            }
            event_type => bail!("Unexpected scraper event type {event_type}"),
        };

        let key = (event.domain, kind);
        let new_cursor = if self.cursors.contains_key(&key) {
            None
        } else {
            Some(StreamCursor::new(sequence, fingerprint)?)
        };
        let result = match self.cursors.get(&key) {
            Some(cursor) => cursor.check(sequence, fingerprint)?,
            None => SequenceResult::Accepted,
        };
        if result == SequenceResult::Accepted {
            match self.cursors.get_mut(&key) {
                Some(cursor) => cursor.accept(sequence, fingerprint)?,
                None => {
                    let _ = self.cursors.insert(
                        key,
                        new_cursor.expect("new cursor is prepared before persistence"),
                    );
                }
            }
        }
        Ok(ValidatedEvent {
            gas_payment: None,
            kind,
            parity: Some(parity),
            sequence: Some(sequence),
            sequence_result: result,
        })
    }

    fn validate_gas_payment(
        &self,
        event: EventMessage<serde_json::Value>,
        source: &ScraperSource,
    ) -> Result<ValidatedEvent> {
        if event.sequence.is_some() {
            bail!("Gas payment event unexpectedly included stream sequence");
        }
        let row_id = event
            .row_id
            .as_deref()
            .context("Gas payment event omitted row ID")?
            .parse::<u64>()
            .context("Invalid gas payment row ID")?;
        let data: GasPaymentEventData =
            serde_json::from_value(event.data).context("Invalid gas payment event payload")?;
        if data
            .id
            .parse::<u64>()
            .context("Invalid gas payment data row ID")?
            != row_id
        {
            bail!("Gas payment data row ID does not match event envelope");
        }
        let stream_cursor = event
            .stream_cursor
            .as_deref()
            .context("Gas payment event omitted stream cursor")?
            .parse::<u64>()
            .context("Invalid gas payment stream cursor")?;
        let legacy_max_stream_cursor = event
            .legacy_max_stream_cursor
            .as_deref()
            .context("Gas payment event omitted legacy cursor boundary")?
            .parse::<u64>()
            .context("Invalid gas payment legacy cursor boundary")?;
        if data.domain != event.domain || data.origin != event.domain {
            bail!("Gas payment payload domain does not match event envelope");
        }
        if parse_address(&data.interchain_gas_paymaster)? != source.interchain_gas_paymaster {
            bail!("Gas payment event paymaster does not match configured paymaster");
        }
        let message_id = parse_h256(&data.msg_id, "gas payment message ID")?;
        let payment = U256::from_dec_str(&data.payment).context("Invalid gas payment amount")?;
        let gas_amount =
            U256::from_dec_str(&data.gas_amount).context("Invalid gas payment gas amount")?;
        let log_index =
            U256::from_dec_str(&data.log_index).context("Invalid gas payment log index")?;
        let sequence = data
            .sequence
            .as_deref()
            .map(|sequence| {
                sequence
                    .parse::<u32>()
                    .context("Invalid gas payment sequence")
            })
            .transpose()?;
        let (block_hash, block_number, transaction_id) = match (
            data.tx_id.as_deref(),
            data.origin_block_hash.as_deref(),
            data.origin_block_height.as_deref(),
            data.origin_tx_hash.as_deref(),
        ) {
            (Some(tx_id), Some(block_hash), Some(block_number), Some(transaction_id)) => {
                tx_id
                    .parse::<u64>()
                    .context("Invalid gas payment transaction row ID")?;
                (
                    parse_h256(block_hash, "gas payment block hash")?,
                    block_number
                        .parse::<u64>()
                        .context("Invalid gas payment block height")?,
                    parse_h512(transaction_id)?,
                )
            }
            (None, None, None, None) => {
                let sequence = sequence.context(
                    "Gas payment without transaction metadata omitted its native sequence",
                )?;
                if log_index != U256::from(sequence) {
                    bail!("Gas payment fallback log index does not match its native sequence");
                }
                // Basic Sealevel RPC metadata retains the real slot, but the
                // proxy's NULL transaction join cannot recover it. Keep RPC authoritative.
                bail!("Gas payment without resolved transaction metadata omitted its canonical block height");
            }
            _ => bail!("Gas payment transaction metadata was only partially resolved"),
        };
        if data.time_created.is_empty() {
            bail!("Gas payment event omitted creation time");
        }
        let encoded = serde_json::to_vec(&data).context("Encoding gas payment fingerprint")?;
        let fingerprint = event_fingerprint(&[
            b"gas_payment",
            &stream_cursor.to_be_bytes(),
            &row_id.to_be_bytes(),
            &encoded,
        ]);
        let (previous_stream_cursor, previous_fingerprint, previous_legacy_max) = self
            .gas_payment_rows
            .get(&event.domain)
            .map(|cursor| {
                (
                    cursor.stream_cursor,
                    cursor.fingerprint,
                    Some(cursor.legacy_max_stream_cursor),
                )
            })
            .or_else(|| {
                self.gas_payment_v2_rows.get(&event.domain).map(|cursor| {
                    (
                        cursor.stream_cursor,
                        None,
                        Some(cursor.legacy_max_stream_cursor),
                    )
                })
            })
            .or_else(|| {
                self.gas_payment_v1_rows
                    .get(&event.domain)
                    .map(|cursor| (cursor.stream_cursor, cursor.fingerprint, None))
            })
            .context("Gas payment event arrived before caught-up baseline")?;
        if previous_legacy_max.is_some_and(|previous| legacy_max_stream_cursor != previous) {
            bail!("Gas payment legacy cursor boundary changed");
        }
        if stream_cursor < previous_stream_cursor {
            bail!("Gas payment stream cursor moved backwards");
        }
        let result = if stream_cursor == previous_stream_cursor {
            if previous_fingerprint.is_some_and(|previous| fingerprint != previous) {
                bail!("Conflicting gas payment event at stream cursor {stream_cursor}");
            }
            SequenceResult::Duplicate
        } else {
            let expected = previous_stream_cursor
                .checked_add(1)
                .context("Gas payment stream cursor exhausted")?;
            if stream_cursor > legacy_max_stream_cursor && stream_cursor != expected {
                return Err(StreamGap {
                    expected,
                    received: stream_cursor,
                }
                .into());
            }
            SequenceResult::Accepted
        };
        let cursor = DurableGasPaymentCursor {
            fingerprint: Some(fingerprint),
            legacy_max_stream_cursor,
            stream_cursor,
        };
        let indexed_payment = Indexed::new(InterchainGasPayment {
            message_id,
            destination: data.destination,
            payment,
            gas_amount,
        });
        Ok(ValidatedEvent {
            gas_payment: Some(GasPaymentInput {
                cursor,
                meta: LogMeta {
                    address: source.interchain_gas_paymaster,
                    block_number,
                    block_hash,
                    transaction_id,
                    transaction_index: 0,
                    log_index,
                },
                payment: sequence.map_or(indexed_payment, |sequence| {
                    indexed_payment.with_sequence(sequence)
                }),
            }),
            kind: EventKind::GasPayment,
            parity: None,
            sequence: None,
            sequence_result: result,
        })
    }

    fn gas_payment_caught_up_cursor(
        &self,
        address: &str,
        source: &ScraperSource,
        legacy_max_stream_cursor: Option<&str>,
        row_id: Option<&str>,
        stream_cursor: Option<&str>,
        sequence: Option<&str>,
    ) -> Result<DurableGasPaymentCursor> {
        if row_id.is_some() || sequence.is_some() {
            bail!("Unexpected scraper caught-up marker");
        }
        let domain = source.domain;
        if parse_address(address)? != source.interchain_gas_paymaster {
            bail!("Gas payment caught-up paymaster does not match configured paymaster");
        }
        let stream_cursor = stream_cursor
            .context("Gas payment caught-up marker omitted stream cursor")?
            .parse::<u64>()
            .context("Invalid gas payment caught-up stream cursor")?;
        let legacy_max_stream_cursor = legacy_max_stream_cursor
            .context("Gas payment caught-up marker omitted legacy cursor boundary")?
            .parse::<u64>()
            .context("Invalid gas payment legacy cursor boundary")?;
        match self.gas_payment_rows.get(&domain) {
            Some(previous) if stream_cursor != previous.stream_cursor => {
                bail!(
                    "Gas payment caught-up stream cursor {stream_cursor} does not equal validated cursor {}",
                    previous.stream_cursor
                )
            }
            Some(previous) if legacy_max_stream_cursor != previous.legacy_max_stream_cursor => {
                bail!("Gas payment legacy cursor boundary changed")
            }
            Some(previous) => Ok(*previous),
            None => {
                if let Some(previous) = self.gas_payment_v2_rows.get(&domain) {
                    if stream_cursor != previous.stream_cursor {
                        bail!(
                            "Gas payment caught-up stream cursor {stream_cursor} does not equal validated cursor {}",
                            previous.stream_cursor
                        )
                    }
                    if legacy_max_stream_cursor != previous.legacy_max_stream_cursor {
                        bail!("Gas payment legacy cursor boundary changed")
                    }
                    return Ok(DurableGasPaymentCursor {
                        fingerprint: None,
                        legacy_max_stream_cursor,
                        stream_cursor,
                    });
                }
                let fingerprint = match self.gas_payment_v1_rows.get(&domain) {
                    Some(previous) if stream_cursor != previous.stream_cursor => {
                        bail!(
                            "Gas payment caught-up stream cursor {stream_cursor} does not equal validated cursor {}",
                            previous.stream_cursor
                        )
                    }
                    Some(previous) => previous.fingerprint,
                    None => None,
                };
                Ok(DurableGasPaymentCursor {
                    fingerprint,
                    legacy_max_stream_cursor,
                    stream_cursor,
                })
            }
        }
    }

    fn persist_gas_payment_cursor<F>(
        &mut self,
        domain: u32,
        cursor: DurableGasPaymentCursor,
        persist: F,
    ) -> Result<()>
    where
        F: FnOnce(&DurableGasPaymentCursor) -> Result<()>,
    {
        persist(&cursor)?;
        self.gas_payment_v1_rows.remove(&domain);
        self.gas_payment_v2_rows.remove(&domain);
        self.gas_payment_rows.insert(domain, cursor);
        Ok(())
    }

    #[cfg(test)]
    fn accept_gas_payment_caught_up(
        &mut self,
        address: &str,
        domain: u32,
        row_id: Option<&str>,
        stream_cursor: Option<&str>,
        sequence: Option<&str>,
        sources: &HashMap<u32, ScraperSource>,
    ) -> Result<()> {
        let source = sources
            .get(&domain)
            .with_context(|| format!("Unexpected scraper caught-up domain {domain}"))?;
        let cursor = self.gas_payment_caught_up_cursor(
            address,
            source,
            Some("0"),
            row_id,
            stream_cursor,
            sequence,
        )?;
        self.gas_payment_rows.insert(domain, cursor);
        Ok(())
    }

    #[cfg(test)]
    fn validate_and_commit_gas_payment(
        &mut self,
        event: EventMessage<serde_json::Value>,
        sources: &HashMap<u32, ScraperSource>,
    ) -> Result<ValidatedEvent> {
        let domain = event.domain;
        let validated = self.validate(event, sources)?;
        let cursor = validated
            .gas_payment
            .as_ref()
            .context("Validated gas payment has no input")?
            .cursor;
        self.persist_gas_payment_cursor(domain, cursor, |_| Ok(()))?;
        Ok(validated)
    }
}

struct ParityJob {
    input: ParityInput,
    queue_permit: OwnedSemaphorePermit,
    sequence: u32,
}

#[derive(Default)]
struct ParityQueue {
    jobs: VecDeque<ParityJob>,
    worker_running: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuthorityCommand {
    pub(crate) desired: bool,
    pub(crate) generation: u64,
}

#[derive(Debug)]
struct AuthorityHandoff {
    expected: HashSet<u32>,
    paused: parking_lot::Mutex<HashMap<u32, u64>>,
    state_changed: Notify,
}

#[derive(Debug)]
struct SourceAuthority {
    health: parking_lot::Mutex<[StreamHealth; 2]>,
    active: Arc<AtomicBool>,
    handoff: Arc<AuthorityHandoff>,
    sender: watch::Sender<AuthorityCommand>,
}

impl AuthorityHandoff {
    fn new(expected: HashSet<u32>) -> Self {
        Self {
            expected,
            paused: parking_lot::Mutex::new(HashMap::new()),
            state_changed: Notify::new(),
        }
    }

    fn mark_paused(&self, domain: u32, generation: u64) {
        if self.expected.contains(&domain)
            && self.paused.lock().insert(domain, generation) != Some(generation)
        {
            self.state_changed.notify_waiters();
        }
    }

    fn mark_running(&self, domain: u32) {
        if self.paused.lock().remove(&domain).is_some() {
            self.state_changed.notify_waiters();
        }
    }

    fn notify_state_changed(&self) {
        self.state_changed.notify_waiters();
    }

    async fn wait_until_paused(
        &self,
        desired: &watch::Sender<AuthorityCommand>,
        generation: u64,
    ) -> bool {
        loop {
            let state_changed = self.state_changed.notified();
            let command = *desired.borrow();
            if !command.desired || command.generation != generation {
                return false;
            }
            let all_paused = {
                let paused = self.paused.lock();
                self.expected
                    .iter()
                    .all(|domain| paused.get(domain) == Some(&generation))
            };
            if all_paused {
                return true;
            }
            state_changed.await;
        }
    }
}

#[derive(Clone)]
pub(crate) struct ScraperAuthorityReceiver {
    desired: watch::Receiver<AuthorityCommand>,
    handoff: Arc<AuthorityHandoff>,
}

impl ScraperAuthorityReceiver {
    pub(crate) fn borrow_and_update(&mut self) -> AuthorityCommand {
        *self.desired.borrow_and_update()
    }

    pub(crate) async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        self.desired.changed().await
    }

    pub(crate) fn mark_paused(&self, domain: u32, generation: u64) {
        self.handoff.mark_paused(domain, generation);
    }

    pub(crate) fn mark_running(&self, domain: u32) {
        self.handoff.mark_running(domain);
    }
}

#[cfg(test)]
struct AuthorityRevocationHook {
    entered: std::sync::mpsc::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
#[derive(Default)]
struct AuthorityRevocationHooks {
    before_publish: Option<AuthorityRevocationHook>,
    after_publish: Option<AuthorityRevocationHook>,
}

type FreshnessProbe = (
    u32,
    String,
    Result<(bool, Option<u32>, Option<u32>, Option<u32>, Option<u32>)>,
);

/// One process-wide, read-only scraper stream monitor.
pub(crate) struct ScraperWebSocketMonitor {
    active: IntGaugeVec,
    authority: IntGaugeVec,
    authority_enabled: bool,
    #[cfg(test)]
    authority_revocation_hooks: parking_lot::Mutex<AuthorityRevocationHooks>,
    #[cfg(test)]
    authority_active: Arc<AtomicBool>,
    #[cfg(test)]
    authority_handoff: Arc<AuthorityHandoff>,
    #[cfg(test)]
    authority_sender: watch::Sender<AuthorityCommand>,
    source_authorities: HashMap<u32, SourceAuthority>,
    caught_up: IntGaugeVec,
    degraded: IntGaugeVec,
    fresh: IntGaugeVec,
    freshness_warned_at: Arc<parking_lot::Mutex<Option<Instant>>>,
    events: IntCounterVec,
    parity: IntCounterVec,
    parity_pending: IntGaugeVec,
    parity_queue_permit: Arc<Semaphore>,
    parity_queues: HashMap<(u32, EventKind), Arc<parking_lot::Mutex<ParityQueue>>>,
    parity_ready: IntGaugeVec,
    parity_read_disabled: AtomicBool,
    parity_read_permit: Arc<Semaphore>,
    parity_unhealthy: Arc<parking_lot::Mutex<std::collections::HashSet<(u32, EventKind)>>>,
    parity_warned_at: Arc<parking_lot::Mutex<Option<Instant>>>,
    gas_payment_enabled: AtomicBool,
    sources: HashMap<u32, ScraperSource>,
    url: Url,
}

impl ScraperWebSocketMonitor {
    #[cfg(test)]
    pub(crate) fn new(
        url: Url,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
    ) -> Result<Self> {
        Self::new_with_authority(url, sources, metrics, false)
    }

    pub(crate) fn new_with_authority(
        url: Url,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
        authority_enabled: bool,
    ) -> Result<Self> {
        let active = metrics.new_int_gauge(
            "relayer_scraper_websocket_active",
            "Whether the relayer scraper-proxy shadow stream is active",
            &["chain"],
        )?;
        let events = metrics.new_int_counter(
            "relayer_scraper_websocket_events",
            "Scraper-proxy shadow events validated by the relayer",
            &["chain", "event_type", "result"],
        )?;
        let authority = metrics.new_int_gauge(
            "relayer_scraper_websocket_authority",
            "Whether scraper-proxy currently replaces direct RPC indexing",
            &["chain"],
        )?;
        let caught_up = metrics.new_int_gauge(
            "relayer_scraper_websocket_caught_up",
            "Whether scraper-proxy replay reached the durable cursor",
            &["chain", "event_type"],
        )?;
        let degraded = metrics.new_int_gauge(
            "relayer_scraper_websocket_degraded",
            "Whether a relayer scraper-proxy shadow stream requires operator repair",
            &["chain", "event_type"],
        )?;
        let fresh = metrics.new_int_gauge(
            "relayer_scraper_websocket_fresh",
            "Whether the durable scraper sequenced cursors match their canonical finalized counts",
            &["chain"],
        )?;
        let parity = metrics.new_int_counter(
            "relayer_scraper_websocket_parity",
            "Read-only parity outcomes for scraper-proxy events against RPC-indexed local DB records",
            &["chain", "event_type", "result"],
        )?;
        let parity_pending = metrics.new_int_gauge(
            "relayer_scraper_websocket_parity_pending",
            "Scraper events awaiting a terminal local DB parity result",
            &["chain", "event_type"],
        )?;
        let parity_ready = metrics.new_int_gauge(
            "relayer_scraper_websocket_parity_ready",
            "Whether every observed scraper event has terminal matching local DB parity",
            &["chain", "event_type"],
        )?;
        let sources = sources
            .into_iter()
            .map(|source| (source.domain, source))
            .collect::<HashMap<_, _>>();
        let source_authorities = sources
            .keys()
            .copied()
            .map(|domain| {
                let handoff = Arc::new(AuthorityHandoff::new(HashSet::from([domain])));
                let (sender, _) = watch::channel(AuthorityCommand {
                    desired: false,
                    generation: 0,
                });
                (
                    domain,
                    SourceAuthority {
                        health: parking_lot::Mutex::new(std::array::from_fn(|_| {
                            StreamHealth::default()
                        })),
                        active: Arc::new(AtomicBool::new(false)),
                        handoff,
                        sender,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        #[cfg(test)]
        let test_authority = source_authorities
            .values()
            .next()
            .expect("test scraper monitor requires a source");
        let mut parity_unhealthy = HashSet::new();
        let mut parity_queues = HashMap::new();
        for source in sources.values() {
            active.with_label_values(&[source.chain.as_str()]).set(0);
            authority.with_label_values(&[source.chain.as_str()]).set(0);
            fresh.with_label_values(&[source.chain.as_str()]).set(0);
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                caught_up
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(0);
                parity_pending
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(0);
                parity_ready
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(0);
                parity_queues.insert(
                    (source.domain, kind),
                    Arc::new(parking_lot::Mutex::new(ParityQueue::default())),
                );
                if source.parity_unhealthy(kind)? {
                    parity_unhealthy.insert((source.domain, kind));
                }
            }
            caught_up
                .with_label_values(&[source.chain.as_str(), GAS_PAYMENT_EVENT_TYPE])
                .set(0);
            degraded
                .with_label_values(&[source.chain.as_str(), GAS_PAYMENT_EVENT_TYPE])
                .set(i64::from(source.gas_payment_degraded()?));
        }
        Ok(Self {
            active,
            authority,
            authority_enabled,
            #[cfg(test)]
            authority_revocation_hooks: parking_lot::Mutex::default(),
            #[cfg(test)]
            authority_active: test_authority.active.clone(),
            #[cfg(test)]
            authority_handoff: test_authority.handoff.clone(),
            #[cfg(test)]
            authority_sender: test_authority.sender.clone(),
            source_authorities,
            caught_up,
            degraded,
            fresh,
            freshness_warned_at: Arc::new(parking_lot::Mutex::new(None)),
            events,
            parity,
            parity_pending,
            parity_queue_permit: Arc::new(Semaphore::new(PARITY_QUEUE_CAPACITY)),
            parity_queues,
            parity_ready,
            parity_read_disabled: AtomicBool::new(false),
            parity_read_permit: Arc::new(Semaphore::new(PARITY_READ_CONCURRENCY)),
            parity_unhealthy: Arc::new(parking_lot::Mutex::new(parity_unhealthy)),
            parity_warned_at: Arc::new(parking_lot::Mutex::new(None)),
            gas_payment_enabled: AtomicBool::new(false),
            sources,
            url,
        })
    }

    pub(crate) fn authority_receiver(&self, domain: u32) -> Option<ScraperAuthorityReceiver> {
        self.authority_enabled.then(|| {
            let authority = self
                .source_authorities
                .get(&domain)
                .expect("authority receiver requested for unknown scraper source");
            ScraperAuthorityReceiver {
                desired: authority.sender.subscribe(),
                handoff: authority.handoff.clone(),
            }
        })
    }

    pub(crate) async fn run(self) {
        let monitor = Arc::new(self);
        let mut state = loop {
            match StreamState::load_gas_payment(&monitor.sources) {
                Ok(state) => break state,
                Err(err) => {
                    warn!(?err, "Loading durable gas payment cursors failed; retrying");
                    sleep(RETRY_DELAY).await;
                }
            }
        };
        loop {
            let plan = loop {
                match SequencedReplayPlan::load(&monitor.sources) {
                    Ok(plan) => break plan,
                    Err(err) => {
                        warn!(
                            ?err,
                            "Loading durable scraper WebSocket cursors failed; retrying"
                        );
                        sleep(RETRY_DELAY).await;
                    }
                }
            };
            state.reset_sequenced(&plan);
            monitor.deactivate_authority();
            monitor.set_active(false);
            monitor.set_caught_up(false);
            let gas_payment_cursors = monitor.gas_payment_cursors(&state);
            let result = monitor
                .stream(&mut state, &plan, &gas_payment_cursors)
                .await;
            monitor.set_active(false);
            monitor.set_caught_up(false);
            monitor.deactivate_authority();
            reconnect_after(result, RETRY_DELAY).await;
        }
    }

    #[cfg(test)]
    async fn observe_parity(
        &self,
        domain: u32,
        kind: EventKind,
        parity_input: ParityInput,
    ) -> &'static str {
        self.note_parity_pending(domain, kind);
        self.observe_parity_inner(domain, kind, parity_input).await
    }

    fn note_parity_pending(&self, domain: u32, kind: EventKind) {
        let source = self
            .sources
            .get(&domain)
            .expect("validated scraper event source must exist");
        let labels = [source.chain.as_str(), kind.label()];
        self.parity_ready.with_label_values(&labels).set(0);
        self.parity_pending.with_label_values(&labels).inc();
    }

    fn cancel_parity_pending(&self, domain: u32, kind: EventKind) {
        let source = self
            .sources
            .get(&domain)
            .expect("validated scraper event source must exist");
        self.parity_pending
            .with_label_values(&[source.chain.as_str(), kind.label()])
            .dec();
    }

    fn stage_parity(
        &self,
        staged: &mut StagedParity,
        domain: u32,
        validated: ValidatedEvent,
    ) -> Result<()> {
        let kind = validated.kind;
        staged.push(domain, validated)?;
        self.note_parity_pending(domain, kind);
        Ok(())
    }

    async fn observe_parity_inner(
        &self,
        domain: u32,
        kind: EventKind,
        parity_input: ParityInput,
    ) -> &'static str {
        let source = self
            .sources
            .get(&domain)
            .expect("validated scraper event source must exist");
        let chain = source.chain.clone();
        let event_type = kind.label();
        let labels = [chain.as_str(), event_type];
        self.parity_ready.with_label_values(&labels).set(0);
        let mut terminal = None;
        for attempt in 1..=PARITY_RETRY_ATTEMPTS {
            if self.parity_read_disabled.load(Ordering::Acquire) {
                terminal = Some("error");
                break;
            }
            let source = source.clone();
            let broadcaster = source.broadcaster.clone();
            let parity_input = parity_input.clone();
            let authority_active = self.source_authority(domain).active.load(Ordering::Acquire);
            let permit = match timeout(
                PARITY_READ_TIMEOUT,
                self.parity_read_permit.clone().acquire_owned(),
            )
            .await
            {
                Ok(Ok(permit)) => permit,
                Ok(Err(_)) => unreachable!("parity semaphore is never closed"),
                Err(_) => {
                    self.disable_parity_reads(&chain, event_type, "read capacity timed out");
                    terminal = Some("error");
                    break;
                }
            };
            if self.parity_read_disabled.load(Ordering::Acquire) {
                drop(permit);
                terminal = Some("error");
                break;
            }
            let mut comparison = tokio::task::spawn_blocking(
                move || -> Result<(ParityResult, Option<IndexingNotification>)> {
                    let _permit = permit;
                    let comparison = parity_input.compare(source.database.as_ref())?;
                    if authority_active && comparison == ParityResult::Missing {
                        let notification = source.store_sequenced_event(&parity_input)?;
                        return Ok((ParityResult::Match, notification));
                    }
                    Ok((comparison, None))
                },
            );
            match timeout(PARITY_READ_TIMEOUT, &mut comparison).await {
                Err(_) => {
                    self.disable_parity_reads(&chain, event_type, "blocking read timed out");
                    terminal = Some("error");
                    break;
                }
                Ok(Ok(Ok((ParityResult::Missing, _)))) if attempt < PARITY_RETRY_ATTEMPTS => {
                    sleep(PARITY_RETRY_DELAY).await;
                }
                Ok(Ok(Ok((ParityResult::Missing, _)))) => {
                    terminal = Some("expired");
                    break;
                }
                Ok(Ok(Ok((result, notification)))) => {
                    if let (Some(broadcaster), Some(notification)) =
                        (broadcaster.as_ref(), notification)
                    {
                        if let Err(err) = broadcaster.send(notification).await {
                            if should_warn(&self.parity_warned_at) {
                                warn!(%chain, event_type, ?err, "Notifying scraper-indexed dispatch failed");
                            }
                        }
                    }
                    terminal = Some(result.label());
                    break;
                }
                Ok(Ok(Err(err))) => {
                    if should_warn(&self.parity_warned_at) {
                        warn!(%chain, event_type, ?err, "Local DB parity comparison failed");
                    }
                    terminal = Some("error");
                    break;
                }
                Ok(Err(err)) => {
                    if should_warn(&self.parity_warned_at) {
                        warn!(%chain, event_type, ?err, "Local DB parity task failed");
                    }
                    terminal = Some("error");
                    break;
                }
            }
        }
        let terminal = terminal.expect("parity retry loop always produces a terminal result");
        self.parity
            .with_label_values(&[chain.as_str(), event_type, terminal])
            .inc();
        if terminal != ParityResult::Match.label() {
            self.parity_unhealthy.lock().insert((domain, kind));
            self.deactivate_source_authority(domain);
            if should_warn(&self.parity_warned_at) {
                warn!(%chain, event_type, result = terminal, "Scraper event did not reach matching local DB parity");
            }
        }
        let pending = self.parity_pending.with_label_values(&labels);
        pending.dec();
        if pending.get() == 0 && !self.parity_unhealthy.lock().contains(&(domain, kind)) {
            self.parity_ready.with_label_values(&labels).set(1);
            // The connection schedules cutover after events and progress probes.
        }
        terminal
    }

    fn disable_parity_reads(&self, chain: &str, event_type: &str, reason: &str) {
        if !self.parity_read_disabled.swap(true, Ordering::AcqRel) {
            warn!(
                chain,
                event_type, reason, "Disabling local DB parity reads until process restart"
            );
            for source in self.sources.values() {
                for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                    self.parity_ready
                        .with_label_values(&[source.chain.as_str(), kind.label()])
                        .set(0);
                    self.parity_unhealthy.lock().insert((source.domain, kind));
                }
            }
            self.deactivate_authority();
        }
    }

    async fn enqueue_accounted_parity(
        self: &Arc<Self>,
        domain: u32,
        kind: EventKind,
        parity_input: ParityInput,
        sequence: u32,
    ) -> Result<bool> {
        if self.parity_read_disabled.load(Ordering::Acquire) {
            return Ok(false);
        }
        // Admission runs between session polls. Waiting here would also stop
        // freshness probes and disconnect detection for every origin.
        let queue_permit = match self.parity_queue_permit.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                self.deactivate_authority();
                bail!("Scraper parity queue is full; restoring RPC fallback");
            }
            Err(tokio::sync::TryAcquireError::Closed) => {
                unreachable!("parity queue semaphore is never closed")
            }
        };
        if self.parity_read_disabled.load(Ordering::Acquire) {
            return Ok(false);
        }
        let queue = self
            .parity_queues
            .get(&(domain, kind))
            .expect("validated scraper stream has a parity queue")
            .clone();
        let start_worker = {
            let mut queue = queue.lock();
            queue.jobs.push_back(ParityJob {
                input: parity_input,
                queue_permit,
                sequence,
            });
            if queue.worker_running {
                false
            } else {
                queue.worker_running = true;
                true
            }
        };
        if start_worker {
            let monitor = self.clone();
            tokio::spawn(async move {
                monitor.drain_parity_queue(domain, kind, queue).await;
            });
        }
        Ok(true)
    }

    #[cfg(test)]
    async fn enqueue_parity(
        self: &Arc<Self>,
        domain: u32,
        kind: EventKind,
        parity_input: ParityInput,
        sequence: u32,
    ) -> bool {
        self.note_parity_pending(domain, kind);
        let enqueued = self
            .enqueue_accounted_parity(domain, kind, parity_input, sequence)
            .await
            .expect("test parity admission");
        if !enqueued {
            self.cancel_parity_pending(domain, kind);
        }
        enqueued
    }

    async fn admit_parity(
        self: &Arc<Self>,
        domain: u32,
        validated: StagedParityEvent,
    ) -> Result<()> {
        if !self
            .enqueue_accounted_parity(domain, validated.kind, validated.parity, validated.sequence)
            .await?
        {
            self.cancel_parity_pending(domain, validated.kind);
        }
        Ok(())
    }

    async fn flush_staged_parity(
        self: &Arc<Self>,
        state: &mut StreamState,
        plan: &SequencedReplayPlan,
        caught_up: &HashMap<(u32, EventKind), i64>,
        domain: u32,
        staged: &mut StagedParity,
    ) -> Result<()> {
        let mut ready = staged.drain_ready(plan, caught_up, state, domain)?;
        while let Some(validated) = ready.pop_front() {
            let kind = validated.kind;
            if let Err(err) = self.admit_parity(domain, validated).await {
                self.cancel_parity_pending(domain, kind);
                for pending in ready {
                    self.cancel_parity_pending(domain, pending.kind);
                }
                return Err(err);
            }
        }
        Ok(())
    }

    fn abandon_staged_parity(&self, staged: &mut StagedParity) {
        for (domain, event) in staged.drain_all() {
            self.cancel_parity_pending(domain, event.kind);
        }
    }

    async fn drain_parity_queue(
        self: Arc<Self>,
        domain: u32,
        kind: EventKind,
        queue: Arc<parking_lot::Mutex<ParityQueue>>,
    ) {
        loop {
            let job = {
                let mut queue = queue.lock();
                match queue.jobs.pop_front() {
                    Some(job) => job,
                    None => {
                        queue.worker_running = false;
                        return;
                    }
                }
            };
            let terminal = self.observe_parity_inner(domain, kind, job.input).await;
            let source = self
                .sources
                .get(&domain)
                .expect("validated scraper event source exists");
            if terminal != ParityResult::Match.label() {
                if let Err(err) = source.store_parity_unhealthy(kind) {
                    warn!(%domain, event_type = kind.label(), ?err, "Persisting scraper parity failure failed; disabling parity work");
                    self.disable_parity_reads(
                        source.chain.as_str(),
                        kind.label(),
                        "durable parity failure state could not be persisted",
                    );
                    self.abandon_parity_queue(domain, kind, &queue);
                    return;
                }
            }
            if let Err(err) = source.store_cursor(kind, job.sequence) {
                warn!(%domain, event_type = kind.label(), ?err, "Persisting scraper parity cursor failed; disabling parity work");
                self.disable_parity_reads(
                    source.chain.as_str(),
                    kind.label(),
                    "durable parity cursor could not be persisted",
                );
                self.abandon_parity_queue(domain, kind, &queue);
                return;
            }
            drop(job.queue_permit);
        }
    }

    fn abandon_parity_queue(
        &self,
        domain: u32,
        kind: EventKind,
        queue: &parking_lot::Mutex<ParityQueue>,
    ) {
        let dropped = {
            let mut queue = queue.lock();
            let dropped = queue.jobs.len();
            queue.jobs.clear();
            queue.worker_running = false;
            dropped
        };
        let source = self
            .sources
            .get(&domain)
            .expect("validated scraper event source exists");
        self.parity_pending
            .with_label_values(&[source.chain.as_str(), kind.label()])
            .sub(dropped as i64);
    }

    #[cfg(test)]
    async fn stream_once(self: &Arc<Self>, state: &mut StreamState) -> Result<()> {
        let plan = SequencedReplayPlan::load(&self.sources)?;
        state.reset_sequenced(&plan);
        let gas_payment_cursors = self.gas_payment_cursors(state);
        self.set_active(false);
        self.set_caught_up(false);
        let result = self.stream(state, &plan, &gas_payment_cursors).await;
        self.set_active(false);
        self.set_caught_up(false);
        result
    }

    async fn stream(
        self: &Arc<Self>,
        state: &mut StreamState,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
    ) -> Result<()> {
        let mut staged_parity = StagedParity::default();
        let result = self
            .stream_inner(state, plan, gas_payment_cursors, &mut staged_parity)
            .await;
        self.abandon_staged_parity(&mut staged_parity);
        result
    }

    async fn stream_inner(
        self: &Arc<Self>,
        state: &mut StreamState,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
        staged_parity: &mut StagedParity,
    ) -> Result<()> {
        let mut socket = ScraperSession::connect(&self.url, StreamTimeouts::default()).await?;
        let mut caught_up = HashMap::new();
        let mut gas_payment_caught_up = HashSet::new();
        loop {
            for source in self.sources.values() {
                if !self
                    .source_authority(source.domain)
                    .active
                    .load(Ordering::Acquire)
                    && self.base_source_authority_ready(source)
                    && self.fresh.with_label_values(&[source.chain.as_str()]).get() == 1
                {
                    let monitor = self.clone();
                    let domain = source.domain;
                    socket.start_cutover(domain, async move {
                        monitor.maybe_activate_source_authority(domain).await;
                    });
                }
            }
            let Some(event) = socket
                .next::<serde_json::Value>(self.authority_enabled, || self.freshness_probes())
                .await?
            else {
                break;
            };
            let message = match event {
                SessionEvent::Message(message) => message,
                SessionEvent::Progress(probe) => {
                    self.apply_freshness(probe);
                    continue;
                }
                SessionEvent::Cutover { .. } => continue,
            };
            match message {
                ServerMessage::Ready {
                    stream_cursor_versions,
                } => {
                    let gas_payment_enabled = stream_cursor_versions.get(GAS_PAYMENT_EVENT_TYPE)
                        == Some(&GAS_PAYMENT_STREAM_CURSOR_VERSION);
                    self.gas_payment_enabled
                        .store(gas_payment_enabled, Ordering::Relaxed);
                    for source in self.sources.values() {
                        self.set_source_caught_up(source, EventKind::GasPayment, false);
                        self.degraded
                            .with_label_values(&[source.chain.as_str(), GAS_PAYMENT_EVENT_TYPE])
                            .set(i64::from(
                                !gas_payment_enabled || source.gas_payment_degraded()?,
                            ));
                    }
                    socket
                        .subscribe(self.subscription(plan, gas_payment_cursors)?)
                        .await?;
                }
                ServerMessage::Subscribed { .. } => {
                    self.set_active(true);
                    info!("Relayer scraper-proxy shadow streams active");
                }
                ServerMessage::Event(event) => {
                    let domain = event.domain;
                    let is_gas_payment = event.event_type == GAS_PAYMENT_EVENT_TYPE;
                    let event_type = event_label(&event.event_type);
                    if is_gas_payment && !self.gas_payment_enabled.load(Ordering::Relaxed) {
                        bail!("Received gas payment event without negotiated cursor support");
                    }
                    if is_gas_payment && state.gas_payment_degraded.contains(&domain) {
                        self.record(domain, GAS_PAYMENT_EVENT_TYPE, "degraded");
                        continue;
                    }
                    match state.validate(event, &self.sources) {
                        Ok(validated) => {
                            let result = match validated.sequence_result {
                                SequenceResult::Accepted => "accepted",
                                SequenceResult::Duplicate => "duplicate",
                            };
                            self.record(domain, validated.kind.label(), result);
                            if validated.parity.is_some() {
                                self.stage_parity(staged_parity, domain, validated)?;
                                self.flush_staged_parity(
                                    state,
                                    plan,
                                    &caught_up,
                                    domain,
                                    staged_parity,
                                )
                                .await?;
                                self.update_source_caught_up(state, plan, &caught_up, domain)
                                    .await?;
                            } else {
                                let source = self.sources.get(&domain).context(
                                    "Validated scraper event source unexpectedly missing",
                                )?;
                                let input = validated
                                    .gas_payment
                                    .context("Validated gas payment has no input")?;
                                source.store_gas_payment(&input)?;
                                state.persist_gas_payment_cursor(
                                    domain,
                                    input.cursor,
                                    |cursor| source.store_gas_payment_cursor(cursor),
                                )?;
                            }
                        }
                        Err(err) => {
                            let result = if err.downcast_ref::<StreamGap>().is_some() {
                                "gap"
                            } else {
                                "invalid"
                            };
                            self.record(domain, event_type, result);
                            if !is_gas_payment || !self.sources.contains_key(&domain) {
                                return Err(err);
                            }
                            let source = self
                                .sources
                                .get(&domain)
                                .context("Invalid gas payment source unexpectedly missing")?;
                            if self.degrade_gas_payment(state, source)? {
                                warn!(
                                    ?err,
                                    domain,
                                    "Relayer scraper-proxy gas payment shadow stream degraded"
                                );
                            }
                        }
                    }
                }
                ServerMessage::CaughtUp {
                    address,
                    domain,
                    event_type,
                    legacy_max_stream_cursor,
                    row_id,
                    stream_cursor,
                    sequence,
                } => {
                    if event_type == GAS_PAYMENT_EVENT_TYPE {
                        if !self.gas_payment_enabled.load(Ordering::Relaxed) {
                            bail!("Received gas payment caught-up marker without negotiated cursor support");
                        }
                        if state.gas_payment_degraded.contains(&domain) {
                            self.record(domain, GAS_PAYMENT_EVENT_TYPE, "degraded");
                            continue;
                        }
                        let source = self.sources.get(&domain).with_context(|| {
                            format!("Unexpected scraper caught-up domain {domain}")
                        })?;
                        let cursor = state.gas_payment_caught_up_cursor(
                            &address,
                            source,
                            legacy_max_stream_cursor.as_deref(),
                            row_id.as_deref(),
                            stream_cursor.as_deref(),
                            sequence.as_deref(),
                        )?;
                        state.persist_gas_payment_cursor(domain, cursor, |cursor| {
                            source.store_gas_payment_cursor(cursor)
                        })?;
                        if !gas_payment_caught_up.insert(domain) {
                            bail!("Received duplicate scraper caught-up marker");
                        }
                        self.set_source_caught_up(source, EventKind::GasPayment, true);
                        self.record(domain, GAS_PAYMENT_EVENT_TYPE, "caught_up");
                        continue;
                    }
                    if row_id.is_some() || stream_cursor.is_some() {
                        bail!("Sequenced scraper caught-up marker included a row/stream cursor");
                    }
                    let kind = EventKind::from_label(&event_type)?;
                    let source = self
                        .sources
                        .get(&domain)
                        .with_context(|| format!("Unexpected scraper caught-up domain {domain}"))?;
                    if parse_address(&address)? != source.address(kind) {
                        bail!("Scraper caught-up address does not match configured contract");
                    }
                    let sequence = sequence
                        .as_deref()
                        .context("Sequenced scraper caught-up marker omitted sequence")?
                        .parse::<i64>()
                        .context("Invalid scraper caught-up sequence")?;
                    if sequence < -1 {
                        bail!("Invalid negative scraper caught-up sequence {sequence}");
                    }
                    validate_caught_up_floor(plan, domain, kind, sequence)?;
                    if plan.source(domain)?.floor(kind).is_none() {
                        state.validate_fresh_baseline(domain, kind, sequence)?;
                    }
                    state.set_baseline(domain, kind, sequence)?;
                    if caught_up.insert((domain, kind), sequence).is_some() {
                        bail!("Received duplicate scraper caught-up marker");
                    }
                    if plan.source(domain)?.floor(kind).is_none()
                        && sequence >= 0
                        && self
                            .parity_pending
                            .with_label_values(&[source.chain.as_str(), kind.label()])
                            .get()
                            == 0
                    {
                        source.store_cursor(
                            kind,
                            sequence
                                .try_into()
                                .context("Scraper caught-up sequence exceeds u32")?,
                        )?;
                    }
                    self.flush_staged_parity(state, plan, &caught_up, domain, staged_parity)
                        .await?;
                    self.update_source_caught_up(state, plan, &caught_up, domain)
                        .await?;
                }
                ServerMessage::Error { error } => {
                    if self.gas_payment_enabled.load(Ordering::Relaxed)
                        && is_unsupported_row_cursor_error(&error)
                    {
                        self.gas_payment_enabled.store(false, Ordering::Relaxed);
                        self.deactivate_authority();
                        for source in self.sources.values() {
                            self.set_source_caught_up(source, EventKind::GasPayment, false);
                            self.degraded
                                .with_label_values(&[source.chain.as_str(), GAS_PAYMENT_EVENT_TYPE])
                                .set(1);
                        }
                        bail!("Scraper-proxy lacks gas payment row cursor support; retrying sequenced streams only");
                    }
                    return Err(RejectedStream(error).into());
                }
                ServerMessage::Other => {}
            }
        }
        Ok(())
    }

    fn subscription(
        &self,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
    ) -> Result<SubscribeMessage<'static>> {
        subscription(
            &self.sources,
            plan,
            gas_payment_cursors,
            self.gas_payment_enabled.load(Ordering::Relaxed),
        )
    }

    fn gas_payment_cursors(&self, state: &StreamState) -> Vec<SubscribedCursor> {
        let mut sources = self.sources.values().collect::<Vec<_>>();
        sources.sort_unstable_by_key(|source| source.domain);
        sources
            .into_iter()
            .map(|source| SubscribedCursor {
                address: scraper_address(source.interchain_gas_paymaster),
                after_stream_cursor: state
                    .gas_payment_resume_cursor(source.domain)
                    .map(|cursor| cursor.to_string()),
                after_sequence: None,
                domain: source.domain,
            })
            .collect()
    }

    fn set_active(&self, active: bool) {
        let value = i64::from(active);
        for source in self.sources.values() {
            self.active
                .with_label_values(&[source.chain.as_str()])
                .set(value);
        }
    }

    fn degrade_gas_payment(&self, state: &mut StreamState, source: &ScraperSource) -> Result<bool> {
        source.store_gas_payment_degraded()?;
        let newly_degraded = state.gas_payment_degraded.insert(source.domain);
        // Invalidate readiness before revoking authority so an in-flight
        // freshness result cannot reactivate the degraded stream.
        self.set_source_caught_up(source, EventKind::GasPayment, false);
        self.degraded
            .with_label_values(&[source.chain.as_str(), GAS_PAYMENT_EVENT_TYPE])
            .set(1);
        self.deactivate_source_authority(source.domain);
        Ok(newly_degraded)
    }

    #[cfg(test)]
    fn wait_for_revocation_hook(&self, before_publish: bool) {
        let hook = {
            let mut hooks = self.authority_revocation_hooks.lock();
            if before_publish {
                hooks.before_publish.take()
            } else {
                hooks.after_publish.take()
            }
        };
        if let Some(hook) = hook {
            hook.entered.send(()).expect("signal revocation hook");
            hook.release
                .recv_timeout(Duration::from_secs(5))
                .expect("release revocation hook");
        }
    }

    fn source_authority(&self, domain: u32) -> &SourceAuthority {
        self.source_authorities
            .get(&domain)
            .expect("validated scraper source must have authority state")
    }

    fn deactivate_source_authority(&self, domain: u32) {
        let source = self
            .sources
            .get(&domain)
            .expect("validated scraper source must exist");
        let authority = self.source_authority(domain);
        // Serialize the active flag and gauges with command publication. RPC must
        // not resume between clearing the flag and a concurrent activation.
        #[cfg(test)]
        self.wait_for_revocation_hook(true);
        authority.sender.send_if_modified(|current| {
            authority
                .health
                .lock()
                .iter_mut()
                .for_each(StreamHealth::reset);
            if authority.active.swap(false, Ordering::AcqRel) {
                info!(
                    chain = source.chain,
                    "Restoring direct RPC indexing fallback"
                );
            }
            self.authority
                .with_label_values(&[source.chain.as_str()])
                .set(0);
            self.fresh
                .with_label_values(&[source.chain.as_str()])
                .set(0);
            if current.desired {
                current.desired = false;
                true
            } else {
                false
            }
        });
        authority.handoff.notify_state_changed();
        #[cfg(test)]
        self.wait_for_revocation_hook(false);
    }

    fn deactivate_authority(&self) {
        let domains = self.sources.keys().copied().collect::<Vec<_>>();
        for domain in domains {
            self.deactivate_source_authority(domain);
        }
    }

    fn refresh_parity_ready(&self, source: &ScraperSource) {
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            let labels = [source.chain.as_str(), kind.label()];
            if self.parity_pending.with_label_values(&labels).get() == 0
                && !self
                    .parity_unhealthy
                    .lock()
                    .contains(&(source.domain, kind))
            {
                self.parity_ready.with_label_values(&labels).set(1);
            }
        }
    }

    async fn maybe_activate_source_authority(&self, domain: u32) {
        let source = self
            .sources
            .get(&domain)
            .expect("validated scraper source must exist");
        let authority = self.source_authority(domain);
        if authority.active.load(Ordering::Acquire)
            || !self.base_source_authority_ready(source)
            || self.fresh.with_label_values(&[source.chain.as_str()]).get() != 1
        {
            return;
        }
        authority.sender.send_if_modified(|current| {
            if current.desired {
                false
            } else {
                current.desired = true;
                current.generation = current
                    .generation
                    .checked_add(1)
                    .expect("Scraper authority generation exhausted");
                true
            }
        });
        let command = *authority.sender.borrow();
        let handoff_complete = matches!(
            timeout(
                AUTHORITY_HANDOFF_TIMEOUT,
                authority
                    .handoff
                    .wait_until_paused(&authority.sender, command.generation),
            )
            .await,
            Ok(true)
        );
        if !handoff_complete
            || *authority.sender.borrow() != command
            || !self.base_source_authority_ready(source)
            || self.fresh.with_label_values(&[source.chain.as_str()]).get() != 1
        {
            if !handoff_complete {
                warn!(
                    chain = source.chain,
                    generation = command.generation,
                    "RPC indexers did not acknowledge scraper authority handoff"
                );
            }
            self.deactivate_source_authority(domain);
            return;
        }
        authority.sender.send_if_modified(|current| {
            // Use the same watch write lock as revocation so neither the flag nor
            // its gauges can be activated after this command has been revoked.
            if *current == command
                && current.desired
                && authority
                    .active
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                self.authority
                    .with_label_values(&[source.chain.as_str()])
                    .set(1);
                info!(
                    chain = source.chain,
                    "Scraper-proxy indexing is authoritative; pausing direct RPC indexing"
                );
            }
            false // Activation does not change the already acknowledged command.
        });
    }

    fn base_source_authority_ready(&self, source: &ScraperSource) -> bool {
        self.authority_enabled
            && self.gas_payment_enabled.load(Ordering::Acquire)
            && self
                .active
                .with_label_values(&[source.chain.as_str()])
                .get()
                == 1
            && [
                EventKind::Dispatch,
                EventKind::GasPayment,
                EventKind::MerkleTreeInsertion,
            ]
            .into_iter()
            .all(|kind| {
                self.caught_up
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .get()
                    == 1
            })
            && self
                .degraded
                .with_label_values(&[source.chain.as_str(), GAS_PAYMENT_EVENT_TYPE])
                .get()
                == 0
            && [EventKind::Dispatch, EventKind::MerkleTreeInsertion]
                .into_iter()
                .all(|kind| {
                    let labels = [source.chain.as_str(), kind.label()];
                    self.parity_pending.with_label_values(&labels).get() == 0
                        && self.parity_ready.with_label_values(&labels).get() == 1
                })
    }

    #[cfg(test)]
    async fn maybe_activate_authority(&self) {
        for domain in self.sources.keys().copied() {
            self.maybe_activate_source_authority(domain).await;
        }
    }

    #[cfg(test)]
    fn base_authority_ready(&self) -> bool {
        !self.sources.is_empty()
            && self
                .sources
                .values()
                .all(|source| self.base_source_authority_ready(source))
    }

    fn freshness_probes(self: &Arc<Self>) -> BoxStream<'static, FreshnessProbe> {
        let ready_sources = self
            .sources
            .values()
            .filter_map(|source| {
                let ready = self.base_source_authority_ready(source);
                if !ready {
                    self.deactivate_source_authority(source.domain);
                }
                ready.then(|| source.clone())
            })
            .collect::<Vec<_>>();
        let monitor = self.clone();
        stream::iter(ready_sources)
            .map(move |source| {
                let monitor = monitor.clone();
                async move {
                    let domain = source.domain;
                    let chain = source.chain.clone();
                    let result = async {
                        let indexer = source
                            .freshness_indexer
                            .clone()
                            .context("Missing canonical dispatch freshness indexer")?;
                        let merkle_indexer = source
                            .merkle_freshness_indexer
                            .clone()
                            .context("Missing canonical Merkle freshness indexer")?;
                        let cursor_source = source.clone();
                        let cursor_read = async {
                            let permit = monitor
                                .parity_read_permit
                                .clone()
                                .acquire_owned()
                                .await
                                .expect("parity semaphore is never closed");
                            if monitor.parity_read_disabled.load(Ordering::Acquire) {
                                bail!("Canonical scraper freshness reads are disabled");
                            }
                            tokio::task::spawn_blocking(move || -> Result<_> {
                                let _permit = permit;
                                Ok((
                                    cursor_source.cursor(EventKind::Dispatch)?,
                                    cursor_source.cursor(EventKind::MerkleTreeInsertion)?,
                                ))
                            })
                            .await
                            .context("Canonical scraper freshness cursor task failed")?
                        };
                        let (dispatch_cursor, merkle_cursor) =
                            match timeout(PARITY_READ_TIMEOUT, cursor_read).await {
                                Ok(result) => result?,
                                Err(_) => {
                                    monitor.disable_parity_reads(
                                        &chain,
                                        DISPATCH_EVENT_TYPE,
                                        "canonical freshness cursor read timed out",
                                    );
                                    bail!("Canonical scraper freshness cursor read timed out");
                                }
                            };
                        // Snapshot durable cursors before RPC. Events may advance
                        // during those calls; comparing newer cursors to older
                        // counts would incorrectly classify progress as rollback.
                        let (dispatch_canonical_count, _) =
                            timeout(RPC_PROBE_TIMEOUT, indexer.latest_sequence_count_and_tip())
                                .await
                                .context("Canonical dispatch freshness probe timed out")??;
                        let (merkle_canonical_count, _) = timeout(
                            RPC_PROBE_TIMEOUT,
                            merkle_indexer.latest_sequence_count_and_tip(),
                        )
                        .await
                        .context("Canonical Merkle freshness probe timed out")??;
                        Ok::<_, eyre::Report>((
                            canonical_cursors_are_fresh(
                                dispatch_canonical_count,
                                dispatch_cursor,
                                merkle_canonical_count,
                                merkle_cursor,
                            )?,
                            dispatch_canonical_count,
                            merkle_canonical_count,
                            dispatch_cursor,
                            merkle_cursor,
                        ))
                    }
                    .await;
                    (domain, chain, result)
                }
            })
            .buffer_unordered(AUTHORITY_FRESHNESS_CONCURRENCY)
            .boxed()
    }

    #[cfg(test)]
    async fn refresh_authority_once(self: &Arc<Self>) {
        let mut probes = self.freshness_probes();
        while let Some(probe) = probes.next().await {
            let domain = probe.0;
            self.apply_freshness(probe);
            self.maybe_activate_source_authority(domain).await;
        }
    }

    fn apply_freshness(&self, (domain, chain, result): FreshnessProbe) {
        match result {
            Ok((
                is_fresh,
                dispatch_canonical_count,
                merkle_canonical_count,
                dispatch_cursor,
                merkle_cursor,
            )) => {
                let source = &self.sources[&domain];
                let mut readiness_still_valid = false;
                let mut within_grace = false;
                let authority = self.source_authority(domain);
                authority.sender.send_if_modified(|_| {
                    if self.base_source_authority_ready(source) {
                        readiness_still_valid = true;
                        // Readiness gates remain strict. Once authoritative, tolerate
                        // sustained canonical lag for the same grace period as validators.
                        if authority.active.load(Ordering::Acquire) {
                            let mut health = authority.health.lock();
                            within_grace = [
                                (dispatch_canonical_count, dispatch_cursor),
                                (merkle_canonical_count, merkle_cursor),
                            ]
                            .into_iter()
                            .zip(health.iter_mut())
                            .all(|((count, cursor), health)| {
                                let next =
                                    cursor.map(|last| last.checked_add(1)).unwrap_or(Some(0));
                                next.is_some_and(|next| {
                                    health
                                        .observe(count.unwrap_or(0), next, true)
                                        .is_ok_and(|usable| usable)
                                })
                            });
                        }
                        self.fresh
                            .with_label_values(&[chain.as_str()])
                            .set(i64::from(is_fresh));
                    }
                    false
                });
                if !readiness_still_valid || (!is_fresh && !within_grace) {
                    if !is_fresh && should_warn(&self.freshness_warned_at) {
                        warn!(
                            %chain,
                            ?dispatch_canonical_count,
                            ?merkle_canonical_count,
                            ?dispatch_cursor,
                            ?merkle_cursor,
                            "Scraper sequenced cursors are not canonically fresh"
                        );
                    }
                    self.deactivate_source_authority(domain);
                }
            }
            Err(err) => {
                if should_warn(&self.freshness_warned_at) {
                    warn!(%chain, ?err, "Canonical scraper freshness probe failed");
                }
                self.deactivate_source_authority(domain);
            }
        }
    }

    fn set_caught_up(&self, caught_up: bool) {
        for source in self.sources.values() {
            for kind in [
                EventKind::Dispatch,
                EventKind::GasPayment,
                EventKind::MerkleTreeInsertion,
            ] {
                self.set_source_caught_up(source, kind, caught_up);
            }
        }
    }

    fn set_source_caught_up(&self, source: &ScraperSource, kind: EventKind, caught_up: bool) {
        self.caught_up
            .with_label_values(&[source.chain.as_str(), kind.label()])
            .set(i64::from(caught_up));
    }

    async fn update_source_caught_up(
        &self,
        state: &StreamState,
        _plan: &SequencedReplayPlan,
        caught_up: &HashMap<(u32, EventKind), i64>,
        domain: u32,
    ) -> Result<()> {
        if !source_caught_up(caught_up, state, domain)? {
            return Ok(());
        }
        let source = self
            .sources
            .get(&domain)
            .context("Validated scraper source is missing")?;
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            self.set_source_caught_up(source, kind, true);
        }
        self.refresh_parity_ready(source);
        Ok(())
    }

    fn record(&self, domain: u32, event_type: &str, result: &str) {
        let chain = self
            .sources
            .get(&domain)
            .map(|source| source.chain.as_str())
            .unwrap_or("unknown");
        self.events
            .with_label_values(&[chain, event_type, result])
            .inc();
    }
}

fn should_warn(warned_at: &parking_lot::Mutex<Option<Instant>>) -> bool {
    let now = Instant::now();
    let mut warned_at = warned_at.lock();
    if warned_at
        .as_ref()
        .is_some_and(|previous| now.duration_since(*previous) < PARITY_WARN_INTERVAL)
    {
        return false;
    }
    *warned_at = Some(now);
    true
}

fn canonical_cursors_are_fresh(
    dispatch_canonical_count: Option<u32>,
    dispatch_cursor: Option<u32>,
    merkle_canonical_count: Option<u32>,
    merkle_cursor: Option<u32>,
) -> Result<bool> {
    let cursor_count = |cursor: Option<u32>, label: &str| {
        cursor
            .map(|cursor| {
                cursor
                    .checked_add(1)
                    .with_context(|| format!("{label} cursor exhausted"))
            })
            .transpose()
            .map(|count| count.unwrap_or(0))
    };
    let dispatch_canonical_count = dispatch_canonical_count.unwrap_or(0);
    let merkle_canonical_count = merkle_canonical_count.unwrap_or(0);
    let dispatch_fresh = validate_cutover_freshness(
        dispatch_canonical_count,
        cursor_count(dispatch_cursor, "Dispatch")?,
    )?;
    let merkle_fresh = validate_cutover_freshness(
        merkle_canonical_count,
        cursor_count(merkle_cursor, "Merkle")?,
    )?;
    Ok(dispatch_fresh && merkle_fresh)
}

fn subscription(
    sources: &HashMap<u32, ScraperSource>,
    plan: &SequencedReplayPlan,
    gas_payment_cursors: &[SubscribedCursor],
    gas_payment_enabled: bool,
) -> Result<SubscribeMessage<'static>> {
    let mut sources = sources.values().collect::<Vec<_>>();
    sources.sort_unstable_by_key(|source| source.domain);
    let domains = sources
        .iter()
        .map(|source| source.domain)
        .collect::<Vec<_>>();
    let cursors = |kind| -> Result<Vec<SubscriptionCursor>> {
        Ok(
            sequenced_subscription_cursors(sources.as_slice(), kind, plan)?
                .into_iter()
                .map(|cursor| {
                    SubscriptionCursor::Sequence(SequenceCursor {
                        address: cursor.address,
                        allow_replay: Some(true),
                        after_sequence: cursor.after_sequence,
                        domain: cursor.domain,
                    })
                })
                .collect(),
        )
    };
    let mut streams = vec![
        SubscribeStream {
            cursors: Some(cursors(EventKind::Dispatch)?),
            domains: Some(domains.clone()),
            event_type: DISPATCH_EVENT_TYPE,
            stream_cursor_version: None,
        },
        SubscribeStream {
            cursors: Some(cursors(EventKind::MerkleTreeInsertion)?),
            domains: Some(domains.clone()),
            event_type: MERKLE_EVENT_TYPE,
            stream_cursor_version: None,
        },
    ];
    if gas_payment_enabled {
        streams.push(SubscribeStream {
            cursors: Some(
                gas_payment_cursors
                    .iter()
                    .map(|cursor| {
                        SubscriptionCursor::GasPayment(GasPaymentSubscriptionCursor {
                            address: cursor.address.clone(),
                            after_stream_cursor: cursor.after_stream_cursor.clone(),
                            domain: cursor.domain,
                        })
                    })
                    .collect(),
            ),
            domains: Some(domains),
            event_type: GAS_PAYMENT_EVENT_TYPE,
            stream_cursor_version: Some(GAS_PAYMENT_STREAM_CURSOR_VERSION),
        });
    }
    Ok(SubscribeMessage {
        streams,
        message_type: "subscribe",
    })
}

fn sequence_cursor(
    source: &ScraperSource,
    kind: EventKind,
    plan: &SequencedReplayPlan,
) -> Result<SequenceCursor> {
    Ok(SequenceCursor {
        address: scraper_address(source.address(kind)),
        allow_replay: Some(true),
        after_sequence: plan
            .source(source.domain)?
            .floor(kind)
            .map(replay_after_sequence),
        domain: source.domain,
    })
}

fn replay_after_sequence(sequence: u32) -> String {
    sequence
        .checked_sub(1)
        .map(|sequence| sequence.to_string())
        .unwrap_or_else(|| "-1".to_owned())
}

fn sequenced_subscription_cursors(
    sources: &[&ScraperSource],
    kind: EventKind,
    plan: &SequencedReplayPlan,
) -> Result<Vec<SubscribedCursor>> {
    sources
        .iter()
        .map(|source| {
            let cursor = sequence_cursor(source, kind, plan)?;
            Ok(SubscribedCursor {
                address: cursor.address,
                after_stream_cursor: None,
                after_sequence: cursor.after_sequence,
                domain: source.domain,
            })
        })
        .collect()
}

fn validate_caught_up_floor(
    plan: &SequencedReplayPlan,
    domain: u32,
    kind: EventKind,
    sequence: i64,
) -> Result<()> {
    if let Some(floor) = plan.source(domain)?.floor(kind) {
        if sequence < i64::from(floor) {
            bail!("Scraper caught-up sequence {sequence} is behind replay floor {floor}");
        }
    }
    Ok(())
}

fn caught_up_baselines(
    caught_up: &HashMap<(u32, EventKind), i64>,
    domain: u32,
) -> Option<(i64, i64)> {
    Some((
        *caught_up.get(&(domain, EventKind::Dispatch))?,
        *caught_up.get(&(domain, EventKind::MerkleTreeInsertion))?,
    ))
}

fn sequenced_persistence_ready(
    plan: &SequencedReplayPlan,
    caught_up: &HashMap<(u32, EventKind), i64>,
    state: &StreamState,
    domain: u32,
    kind: EventKind,
    sequence: u32,
) -> Result<bool> {
    if plan.source(domain)?.floor(kind).is_some() {
        return Ok(true);
    }
    let Some(baseline) = caught_up.get(&(domain, kind)).copied() else {
        return Ok(false);
    };
    state.validate_fresh_baseline(domain, kind, baseline)?;
    let expected = baseline
        .checked_add(1)
        .context("Scraper caught-up sequence exhausted")?;
    Ok(i64::from(sequence) >= expected)
}

fn source_caught_up(
    caught_up: &HashMap<(u32, EventKind), i64>,
    state: &StreamState,
    domain: u32,
) -> Result<bool> {
    let Some((dispatch, merkle)) = caught_up_baselines(caught_up, domain) else {
        return Ok(false);
    };
    for (kind, target) in [
        (EventKind::Dispatch, dispatch),
        (EventKind::MerkleTreeInsertion, merkle),
    ] {
        if target < 0 {
            state.validate_fresh_baseline(domain, kind, target)?;
            continue;
        }
        let Some(cursor) = state.cursors.get(&(domain, kind)) else {
            return Ok(false);
        };
        if i64::from(cursor.latest_sequence()?) < target {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
fn validate_subscription(
    streams: &[SubscribedStream],
    sources: &HashMap<u32, ScraperSource>,
    plan: &SequencedReplayPlan,
    gas_payment_cursors: &[SubscribedCursor],
    gas_payment_enabled: bool,
) -> Result<()> {
    hyperlane_base::scraper_websocket::validate_subscription(
        &subscription(sources, plan, gas_payment_cursors, gas_payment_enabled)?.confirmation(),
        streams,
    )
}

fn is_unsupported_row_cursor_error(error: &str) -> bool {
    error.contains("cursors are only supported for sequenced streams")
        || error.contains("row ID cursors are not supported")
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DispatchEventData {
    destination_domain: u32,
    id: StringOrNumber,
    msg_body: Option<String>,
    msg_id: String,
    nonce: StringOrNumber,
    origin_block_hash: String,
    origin_block_height: StringOrNumber,
    origin_domain: u32,
    origin_mailbox: String,
    origin_tx_hash: String,
    recipient: String,
    sender: String,
    time_created: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GasPaymentEventData {
    destination: u32,
    domain: u32,
    gas_amount: String,
    id: String,
    interchain_gas_paymaster: String,
    log_index: String,
    msg_id: String,
    origin: u32,
    origin_block_hash: Option<String>,
    origin_block_height: Option<String>,
    origin_tx_hash: Option<String>,
    payment: String,
    sequence: Option<String>,
    time_created: String,
    tx_id: Option<String>,
}

fn parse_address(value: &str) -> Result<H256> {
    bytes_to_address(parse_hex(value)?).context("Invalid scraper event address")
}

fn parse_h256(value: &str, field: &str) -> Result<H256> {
    let bytes = parse_hex(value)?;
    if bytes.len() != 32 {
        bail!("Invalid {field} length {}", bytes.len());
    }
    Ok(H256::from_slice(&bytes))
}

fn parse_h512(value: &str) -> Result<H512> {
    let bytes = parse_hex(value)?;
    if !matches!(bytes.len(), 32 | 64) {
        bail!("Invalid origin transaction hash length {}", bytes.len());
    }
    Ok(bytes_to_h512(&bytes))
}

fn event_fingerprint(fields: &[&[u8]]) -> H256 {
    let mut hasher = Keccak256::new();
    for field in fields {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    H256::from_slice(&hasher.finalize())
}

fn parse_hex(value: &str) -> Result<Vec<u8>> {
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("\\x"))
        .unwrap_or(value);
    hex::decode(value).context("Invalid hexadecimal scraper event field")
}

fn event_label(event_type: &str) -> &'static str {
    match event_type {
        DISPATCH_EVENT_TYPE => DISPATCH_EVENT_TYPE,
        GAS_PAYMENT_EVENT_TYPE => GAS_PAYMENT_EVENT_TYPE,
        MERKLE_EVENT_TYPE => MERKLE_EVENT_TYPE,
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use std::ops::RangeInclusive;

    use super::*;
    use async_trait::async_trait;
    use futures_util::{SinkExt, StreamExt};
    use hyperlane_base::db::{test_utils, DB};
    use hyperlane_core::{ChainResult, HyperlaneDomain, Indexer, SequenceAwareIndexer};
    use prometheus::Registry;
    use tokio::{net::TcpListener, sync::oneshot};
    use tokio_tungstenite::{accept_async, tungstenite::Message};

    struct Fixture {
        _temp_dir: tempfile::TempDir,
        database: HyperlaneRocksDB,
        sources: HashMap<u32, ScraperSource>,
    }

    #[derive(Debug)]
    struct FixedSequenceIndexer(u32);

    #[async_trait]
    impl Indexer<HyperlaneMessage> for FixedSequenceIndexer {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
            unreachable!("freshness tests only query the sequence count")
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            unreachable!("freshness tests only query the sequence count")
        }
    }

    #[async_trait]
    impl SequenceAwareIndexer<HyperlaneMessage> for FixedSequenceIndexer {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            Ok((Some(self.0), 0))
        }
    }

    #[async_trait]
    impl Indexer<MerkleTreeInsertion> for FixedSequenceIndexer {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<MerkleTreeInsertion>, LogMeta)>> {
            unreachable!("freshness tests only query the sequence count")
        }

        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            unreachable!("freshness tests only query the sequence count")
        }
    }

    #[async_trait]
    impl SequenceAwareIndexer<MerkleTreeInsertion> for FixedSequenceIndexer {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            Ok((Some(self.0), 0))
        }
    }

    struct AdvancingSequenceIndexer(ScraperSource);

    impl std::fmt::Debug for AdvancingSequenceIndexer {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("AdvancingSequenceIndexer")
        }
    }

    #[async_trait]
    impl Indexer<HyperlaneMessage> for AdvancingSequenceIndexer {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
            unreachable!("freshness test only queries counts")
        }
        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            unreachable!("freshness test only queries counts")
        }
    }

    #[async_trait]
    impl SequenceAwareIndexer<HyperlaneMessage> for AdvancingSequenceIndexer {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            // A new event reaches the database after this RPC's count snapshot.
            self.0
                .store_cursor(EventKind::Dispatch, 10)
                .expect("advance cursor during RPC");
            Ok((Some(10), 0))
        }
    }

    #[tokio::test]
    async fn freshness_does_not_compare_new_cursors_to_older_rpc_counts() {
        let fixture = fixture();
        let source = fixture.sources[&5].clone();
        source
            .store_cursor(EventKind::Dispatch, 9)
            .expect("dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 9)
            .expect("Merkle cursor");
        let advancing = Arc::new(AdvancingSequenceIndexer(source.clone()));
        let source = source
            .with_freshness_indexer(advancing)
            .with_merkle_freshness_indexer(Arc::new(FixedSequenceIndexer(10)));
        let metrics =
            CoreMetrics::new("scraper-snapshot-test", 9090, Registry::new()).expect("metrics");
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new_with_authority(
                Url::parse("ws://localhost:1").expect("URL"),
                vec![source],
                &metrics,
                true,
            )
            .expect("monitor"),
        );
        monitor.set_active(true);
        monitor.gas_payment_enabled.store(true, Ordering::Release);
        let source = &monitor.sources[&5];
        for kind in [
            EventKind::Dispatch,
            EventKind::GasPayment,
            EventKind::MerkleTreeInsertion,
        ] {
            monitor.set_source_caught_up(source, kind, true);
        }
        monitor.refresh_parity_ready(source);
        let (_, _, result) = monitor.freshness_probes().next().await.expect("probe");
        let (fresh, _, _, dispatch_cursor, _) = result.expect("progress must not be rollback");
        assert!(fresh);
        assert_eq!(dispatch_cursor, Some(9));
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("current cursor"),
            Some(10)
        );
    }

    fn source(database: HyperlaneRocksDB) -> ScraperSource {
        ScraperSource::new(
            "test".to_owned(),
            5,
            H256::from_low_u64_be(1),
            H256::from_low_u64_be(3),
            H256::from_low_u64_be(2),
            database,
        )
    }

    fn fixture() -> Fixture {
        let temp_dir = tempfile::tempdir().expect("temp DB directory");
        let db = DB::from_path(temp_dir.path()).expect("open temp DB");
        let database =
            HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("scraper-parity"), db);
        Fixture {
            _temp_dir: temp_dir,
            database: database.clone(),
            sources: HashMap::from([(5, source(database))]),
        }
    }

    fn sources() -> HashMap<u32, ScraperSource> {
        sources_for(&[5])
    }

    fn sources_for(domains: &[u32]) -> HashMap<u32, ScraperSource> {
        let tempdir = tempfile::tempdir().expect("temporary scraper cursor DB");
        let db = test_utils::setup_db(tempdir.path().to_string_lossy().into_owned());
        std::mem::forget(tempdir);
        domains
            .iter()
            .copied()
            .map(|domain| {
                let chain = format!("test-{domain}");
                let db =
                    HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain(&chain), db.clone());
                (
                    domain,
                    ScraperSource::new(
                        chain,
                        domain,
                        H256::from_low_u64_be(1),
                        H256::from_low_u64_be(3),
                        H256::from_low_u64_be(2),
                        db,
                    ),
                )
            })
            .collect()
    }

    fn monitor(database: std::sync::Arc<dyn ParityDatabase>) -> ScraperWebSocketMonitor {
        let metrics = CoreMetrics::new("scraper-parity-test", 9090, Registry::new())
            .expect("create test metrics");
        ScraperWebSocketMonitor::new(
            Url::parse("ws://localhost:1").expect("test URL"),
            vec![ScraperSource::with_database(
                "test".to_owned(),
                5,
                H256::from_low_u64_be(1),
                H256::from_low_u64_be(3),
                H256::from_low_u64_be(2),
                database,
            )],
            &metrics,
        )
        .expect("create test monitor")
    }

    #[tokio::test]
    async fn authority_waits_for_rpc_pause_restores_fallback_and_reactivates() {
        let fixture = fixture();
        let metrics = CoreMetrics::new("scraper-authority-test", 9090, Registry::new())
            .expect("create test metrics");
        let monitor = ScraperWebSocketMonitor::new_with_authority(
            Url::parse("ws://localhost:1").expect("test URL"),
            fixture.sources.into_values().collect(),
            &metrics,
            true,
        )
        .expect("create authority monitor");
        let mut receiver = monitor.authority_receiver(5).expect("authority receiver");

        monitor.set_active(true);
        monitor.gas_payment_enabled.store(true, Ordering::Release);
        for source in monitor.sources.values() {
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                monitor.set_source_caught_up(source, kind, true);
            }
            monitor.refresh_parity_ready(source);
        }
        monitor.maybe_activate_authority().await;
        assert!(!receiver.borrow_and_update().desired);

        for source in monitor.sources.values() {
            monitor.set_source_caught_up(source, EventKind::GasPayment, true);
            monitor
                .fresh
                .with_label_values(&[source.chain.as_str()])
                .set(1);
        }
        let activation = monitor.maybe_activate_authority();
        tokio::pin!(activation);
        assert!(timeout(Duration::from_millis(10), &mut activation)
            .await
            .is_err());
        let command = receiver.borrow_and_update();
        assert!(command.desired);
        assert!(!monitor.authority_active.load(Ordering::Acquire));
        monitor.authority_handoff.mark_paused(5, command.generation);
        activation.await;
        assert!(monitor.authority_active.load(Ordering::Acquire));

        monitor.deactivate_authority();
        assert!(!receiver.borrow_and_update().desired);
        monitor.authority_handoff.mark_running(5);

        monitor.set_active(false);
        monitor.set_caught_up(false);
        monitor.set_active(true);
        for source in monitor.sources.values() {
            for kind in [
                EventKind::Dispatch,
                EventKind::GasPayment,
                EventKind::MerkleTreeInsertion,
            ] {
                monitor.set_source_caught_up(source, kind, true);
            }
            monitor.refresh_parity_ready(source);
            monitor
                .fresh
                .with_label_values(&[source.chain.as_str()])
                .set(1);
        }
        let command = {
            let activation = monitor.maybe_activate_authority();
            tokio::pin!(activation);
            assert!(timeout(Duration::from_millis(10), &mut activation)
                .await
                .is_err());
            let command = receiver.borrow_and_update();
            monitor.authority_handoff.mark_paused(5, command.generation);
            activation.await;
            command
        };
        assert!(command.desired);
        assert!(monitor.authority_active.load(Ordering::Acquire));
    }

    #[test]
    fn authority_revocation_serializes_flag_and_gauges_with_command() {
        let fixture = fixture();
        let metrics = CoreMetrics::new("scraper-authority-revocation-test", 9090, Registry::new())
            .expect("create test metrics");
        let monitor = ScraperWebSocketMonitor::new_with_authority(
            Url::parse("ws://localhost:1").expect("test URL"),
            fixture.sources.into_values().collect(),
            &metrics,
            true,
        )
        .expect("create authority monitor");
        monitor
            .authority_sender
            .send_modify(|command| command.desired = true);
        monitor.authority_active.store(true, Ordering::Release);
        let authority = monitor.authority.with_label_values(&["test"]);
        let fresh = monitor.fresh.with_label_values(&["test"]);
        authority.set(1);
        fresh.set(1);

        // Pause revocation exactly before command publication, avoiding any
        // dependence on how quickly its thread is scheduled.
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        monitor.authority_revocation_hooks.lock().before_publish = Some(AuthorityRevocationHook {
            entered: entered_tx,
            release: release_rx,
        });
        let receiver = monitor.authority_sender.subscribe();
        std::thread::scope(|threads| {
            threads.spawn(|| monitor.deactivate_authority());
            entered_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("revocation reached publication");
            let remained_active = monitor.authority_active.load(Ordering::Acquire);
            let authority_before_publication = authority.get();
            let fresh_before_publication = fresh.get();
            let desired_before_publication = receiver.borrow().desired;
            release_tx.send(()).expect("release revocation");
            assert!(remained_active);
            assert!(desired_before_publication);
            assert_eq!(authority_before_publication, 1);
            assert_eq!(fresh_before_publication, 1);
        });
        assert!(!receiver.borrow().desired);
        assert!(!monitor.authority_active.load(Ordering::Acquire));
        assert_eq!(authority.get(), 0);
        assert_eq!(fresh.get(), 0);
    }

    #[tokio::test]
    async fn authority_handoff_timeout_restores_rpc_fallback() {
        let metrics = CoreMetrics::new("scraper-authority-timeout-test", 9090, Registry::new())
            .expect("create test metrics");
        let monitor = ScraperWebSocketMonitor::new_with_authority(
            Url::parse("ws://localhost:1").expect("test URL"),
            sources_for(&[5]).into_values().collect(),
            &metrics,
            true,
        )
        .expect("create authority monitor");
        let mut observer = monitor.authority_receiver(5).expect("authority observer");

        monitor.set_active(true);
        monitor.gas_payment_enabled.store(true, Ordering::Release);
        for source in monitor.sources.values() {
            for kind in [
                EventKind::Dispatch,
                EventKind::GasPayment,
                EventKind::MerkleTreeInsertion,
            ] {
                monitor.set_source_caught_up(source, kind, true);
            }
            monitor.refresh_parity_ready(source);
            monitor
                .fresh
                .with_label_values(&[source.chain.as_str()])
                .set(1);
        }

        monitor.maybe_activate_authority().await;

        assert!(!monitor.source_authority(5).active.load(Ordering::Acquire));
        assert!(!observer.borrow_and_update().desired);
        assert!(monitor.source_authority(5).handoff.paused.lock().is_empty());
    }

    #[tokio::test]
    async fn sources_activate_and_revoke_authority_independently() {
        let metrics = CoreMetrics::new("scraper-authority-per-source-test", 9090, Registry::new())
            .expect("create test metrics");
        let monitor = ScraperWebSocketMonitor::new_with_authority(
            Url::parse("ws://localhost:1").expect("test URL"),
            sources_for(&[5, 6]).into_values().collect(),
            &metrics,
            true,
        )
        .expect("create authority monitor");
        let mut source_5_receiver = monitor.authority_receiver(5).expect("source 5 receiver");
        let mut source_6_receiver = monitor.authority_receiver(6).expect("source 6 receiver");

        monitor.set_active(true);
        monitor.gas_payment_enabled.store(true, Ordering::Release);
        let source_5 = monitor.sources.get(&5).expect("source 5");
        for kind in [
            EventKind::Dispatch,
            EventKind::GasPayment,
            EventKind::MerkleTreeInsertion,
        ] {
            monitor.set_source_caught_up(source_5, kind, true);
        }
        monitor.refresh_parity_ready(source_5);
        monitor
            .fresh
            .with_label_values(&[source_5.chain.as_str()])
            .set(1);

        let source_5_activation = monitor.maybe_activate_source_authority(5);
        tokio::pin!(source_5_activation);
        assert!(timeout(Duration::from_millis(10), &mut source_5_activation)
            .await
            .is_err());
        let source_5_command = source_5_receiver.borrow_and_update();
        assert!(source_5_command.desired);
        assert!(!source_6_receiver.borrow_and_update().desired);

        // An acknowledgement for another origin cannot complete this handoff.
        source_5_receiver.mark_paused(6, source_5_command.generation);
        assert!(timeout(Duration::from_millis(10), &mut source_5_activation)
            .await
            .is_err());
        source_5_receiver.mark_paused(5, source_5_command.generation);
        source_5_activation.await;
        assert!(monitor.source_authority(5).active.load(Ordering::Acquire));
        assert!(!monitor.source_authority(6).active.load(Ordering::Acquire));

        let source_6 = monitor.sources.get(&6).expect("source 6");
        for kind in [
            EventKind::Dispatch,
            EventKind::GasPayment,
            EventKind::MerkleTreeInsertion,
        ] {
            monitor.set_source_caught_up(source_6, kind, true);
        }
        monitor.refresh_parity_ready(source_6);
        monitor
            .fresh
            .with_label_values(&[source_6.chain.as_str()])
            .set(1);
        let source_6_activation = monitor.maybe_activate_source_authority(6);
        tokio::pin!(source_6_activation);
        assert!(timeout(Duration::from_millis(10), &mut source_6_activation)
            .await
            .is_err());
        let source_6_command = source_6_receiver.borrow_and_update();
        source_6_receiver.mark_paused(6, source_6_command.generation);
        source_6_activation.await;
        assert!(monitor.source_authority(6).active.load(Ordering::Acquire));

        monitor.deactivate_source_authority(6);
        assert!(monitor.source_authority(5).active.load(Ordering::Acquire));
        assert!(source_5_receiver.borrow_and_update().desired);
        assert!(!monitor.source_authority(6).active.load(Ordering::Acquire));
        assert!(!source_6_receiver.borrow_and_update().desired);
    }

    #[test]
    fn canonical_freshness_compares_each_stream_to_its_own_count() {
        assert!(canonical_cursors_are_fresh(None, None, None, None).expect("empty chain is fresh"));
        assert!(
            canonical_cursors_are_fresh(Some(111), Some(110), Some(101), Some(100))
                .expect("each stream cursor matches its canonical count")
        );
        assert!(
            !canonical_cursors_are_fresh(Some(111), Some(110), Some(101), Some(99))
                .expect("lagging Merkle cursor is stale")
        );
        assert!(
            !canonical_cursors_are_fresh(Some(111), Some(109), Some(101), Some(100))
                .expect("lagging dispatch cursor is stale")
        );
        assert!(canonical_cursors_are_fresh(
            Some(u32::MAX),
            Some(u32::MAX),
            Some(u32::MAX),
            Some(u32::MAX),
        )
        .is_err());
    }

    #[test]
    fn unequal_stream_tips_resume_and_catch_up_independently() {
        let sources = sources();
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 100)
            .expect("store dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 90)
            .expect("store Merkle cursor");

        let plan = replay_plan(&sources);
        let mut state = replay_state(&plan);
        let source_plan = plan.source(5).expect("source plan");
        assert_eq!(source_plan.dispatch_floor, Some(100));
        assert_eq!(source_plan.merkle_floor, Some(90));
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 100, dispatch_data(100, b"dispatch")),
                &sources,
            )
            .expect("replay dispatch boundary");
        state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    90,
                    merkle_data_for(90, H256::from_low_u64_be(2), H256::from_low_u64_be(90), 100),
                ),
                &sources,
            )
            .expect("replay Merkle boundary");
        assert!(source_caught_up(
            &HashMap::from([
                ((5, EventKind::Dispatch), 100),
                ((5, EventKind::MerkleTreeInsertion), 90),
            ]),
            &state,
            5,
        )
        .expect("independent caught-up frontiers"));

        let request: serde_json::Value = serde_json::to_value(
            &subscription(&sources, &plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");
        assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "99");
        assert_eq!(request["streams"][1]["cursors"][0]["afterSequence"], "89");
    }

    #[tokio::test]
    async fn canonical_freshness_restores_fallback_then_reacquires() {
        for (lag_index, lagging_kind) in [EventKind::Dispatch, EventKind::MerkleTreeInsertion]
            .into_iter()
            .enumerate()
        {
            let fixture = fixture();
            let mut source = fixture.sources[&5].clone();
            source
                .store_cursor(
                    EventKind::Dispatch,
                    if lagging_kind == EventKind::Dispatch {
                        8
                    } else {
                        9
                    },
                )
                .expect("store dispatch cursor");
            source
                .store_cursor(
                    EventKind::MerkleTreeInsertion,
                    if lagging_kind == EventKind::MerkleTreeInsertion {
                        8
                    } else {
                        9
                    },
                )
                .expect("store lagging Merkle cursor");
            source = source
                .with_freshness_indexer(Arc::new(FixedSequenceIndexer(10)))
                .with_merkle_freshness_indexer(Arc::new(FixedSequenceIndexer(10)));
            let metrics =
                CoreMetrics::new("scraper-authority-frontier-test", 9090, Registry::new())
                    .expect("create test metrics");
            let monitor = Arc::new(
                ScraperWebSocketMonitor::new_with_authority(
                    Url::parse("ws://localhost:1").expect("test URL"),
                    vec![source],
                    &metrics,
                    true,
                )
                .expect("create authority monitor"),
            );
            let mut receiver = monitor.authority_receiver(5).expect("authority receiver");
            monitor.set_active(true);
            monitor.gas_payment_enabled.store(true, Ordering::Release);
            for source in monitor.sources.values() {
                for kind in [
                    EventKind::Dispatch,
                    EventKind::GasPayment,
                    EventKind::MerkleTreeInsertion,
                ] {
                    monitor.set_source_caught_up(source, kind, true);
                }
                monitor.refresh_parity_ready(source);
                monitor
                    .fresh
                    .with_label_values(&[source.chain.as_str()])
                    .set(1);
            }
            monitor.authority_active.store(true, Ordering::Release);

            monitor.refresh_authority_once().await;
            assert!(monitor.authority_active.load(Ordering::Acquire));
            monitor.source_authority(5).health.lock()[lag_index] =
                StreamHealth::new(Duration::ZERO);
            monitor.refresh_authority_once().await;
            assert!(!monitor.authority_active.load(Ordering::Acquire));
            assert!(!receiver.borrow_and_update().desired);
            assert_eq!(monitor.fresh.with_label_values(&["test"]).get(), 0);

            let source = &monitor.sources[&5];
            source
                .store_cursor(lagging_kind, 9)
                .expect("advance Merkle cursor");
            let refresh = monitor.refresh_authority_once();
            tokio::pin!(refresh);
            assert!(timeout(Duration::from_millis(10), &mut refresh)
                .await
                .is_err());
            let command = receiver.borrow_and_update();
            assert!(command.desired);
            monitor.authority_handoff.mark_paused(5, command.generation);
            refresh.await;

            assert!(monitor.authority_active.load(Ordering::Acquire));
            assert_eq!(monitor.fresh.with_label_values(&["test"]).get(), 1);
        }
    }

    #[tokio::test]
    async fn gas_degradation_blocks_in_flight_freshness_reactivation() {
        let fixture = fixture();
        let source = fixture.sources[&5]
            .clone()
            .with_freshness_indexer(Arc::new(FixedSequenceIndexer(10)))
            .with_merkle_freshness_indexer(Arc::new(FixedSequenceIndexer(10)));
        source
            .store_cursor(EventKind::Dispatch, 9)
            .expect("dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 9)
            .expect("Merkle cursor");
        let metrics = CoreMetrics::new("scraper-gas-freshness-test", 9090, Registry::new())
            .expect("test metrics");
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new_with_authority(
                Url::parse("ws://localhost:1").expect("test URL"),
                vec![source],
                &metrics,
                true,
            )
            .expect("authority monitor"),
        );
        monitor.set_active(true);
        monitor.gas_payment_enabled.store(true, Ordering::Release);
        let source = &monitor.sources[&5];
        for kind in [
            EventKind::Dispatch,
            EventKind::GasPayment,
            EventKind::MerkleTreeInsertion,
        ] {
            monitor.set_source_caught_up(source, kind, true);
        }
        monitor.refresh_parity_ready(source);
        monitor.fresh.with_label_values(&["test"]).set(1);
        monitor.authority.with_label_values(&["test"]).set(1);
        monitor.authority_active.store(true, Ordering::Release);
        monitor
            .authority_sender
            .send_modify(|command| command.desired = true);

        // Start a valid freshness probe, but hold its cursor read until gas
        // degradation has published revocation and paused before returning.
        let permits =
            u32::try_from(monitor.parity_read_permit.available_permits()).expect("permit count");
        let capacity = monitor
            .parity_read_permit
            .clone()
            .acquire_many_owned(permits)
            .await
            .expect("cursor capacity");
        let mut refresh = Box::pin(monitor.refresh_authority_once());
        assert!(futures::poll!(&mut refresh).is_pending());
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        monitor.authority_revocation_hooks.lock().after_publish = Some(AuthorityRevocationHook {
            entered: entered_tx,
            release: release_rx,
        });
        let worker_monitor = monitor.clone();
        let worker = std::thread::spawn(move || {
            let mut state = StreamState::default();
            worker_monitor.degrade_gas_payment(&mut state, &worker_monitor.sources[&5])
        });
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("gas degradation revoked authority");
        drop(capacity);
        let refreshed = timeout(Duration::from_secs(2), &mut refresh).await.is_ok();
        drop(refresh);
        let active = monitor.authority_active.load(Ordering::Acquire);
        let command = *monitor.authority_sender.borrow();
        let fresh = monitor.fresh.with_label_values(&["test"]).get();
        release_tx.send(()).expect("release gas degradation");
        assert!(worker
            .join()
            .expect("degradation thread")
            .expect("gas degradation"));
        assert!(refreshed, "degraded stream must not request a new handoff");
        assert!(!active);
        assert!(!command.desired);
        assert_eq!(
            command.generation, 0,
            "degraded stream must not request another handoff"
        );
        assert_eq!(fresh, 0);
        assert_eq!(monitor.authority.with_label_values(&["test"]).get(), 0);
        assert!(source.gas_payment_degraded().expect("durable degradation"));
    }

    #[tokio::test]
    async fn freshness_read_capacity_timeout_restores_fallback_and_stops_retries() {
        let fixture = fixture();
        let source = fixture.sources[&5]
            .clone()
            .with_freshness_indexer(Arc::new(FixedSequenceIndexer(10)))
            .with_merkle_freshness_indexer(Arc::new(FixedSequenceIndexer(10)));
        let metrics = CoreMetrics::new("scraper-freshness-timeout-test", 9090, Registry::new())
            .expect("create test metrics");
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new_with_authority(
                Url::parse("ws://localhost:1").expect("test URL"),
                vec![source],
                &metrics,
                true,
            )
            .expect("create authority monitor"),
        );
        let mut receiver = monitor.authority_receiver(5).expect("authority receiver");
        monitor.set_active(true);
        monitor.gas_payment_enabled.store(true, Ordering::Release);
        monitor.set_caught_up(true);
        monitor.refresh_parity_ready(&monitor.sources[&5]);
        monitor.fresh.with_label_values(&["test"]).set(1);
        monitor.authority_active.store(true, Ordering::Release);
        monitor
            .authority_sender
            .send_modify(|command| command.desired = true);

        let permits = monitor
            .parity_read_permit
            .clone()
            .acquire_many_owned(
                PARITY_READ_CONCURRENCY
                    .try_into()
                    .expect("bounded concurrency"),
            )
            .await
            .expect("reserve all read capacity");
        timeout(Duration::from_secs(2), monitor.refresh_authority_once())
            .await
            .expect("freshness check must not wait indefinitely for local reads");
        assert!(!monitor.authority_active.load(Ordering::Acquire));
        assert!(!receiver.borrow_and_update().desired);
        assert!(monitor.parity_read_disabled.load(Ordering::Acquire));
        assert_eq!(monitor.fresh.with_label_values(&["test"]).get(), 0);
        assert!(!monitor.base_authority_ready());

        timeout(Duration::from_millis(50), monitor.refresh_authority_once())
            .await
            .expect("disabled freshness reads must not queue further work");
        drop(permits);
        assert_eq!(
            monitor.parity_read_permit.available_permits(),
            PARITY_READ_CONCURRENCY
        );
    }

    #[tokio::test]
    async fn authority_stores_missing_dispatch_before_advancing_parity() {
        let mut fixture = fixture();
        let broadcaster = BroadcastMpscSender::new(1);
        let mut notifications = broadcaster.get_receiver().await;
        fixture
            .sources
            .get_mut(&5)
            .expect("test source")
            .broadcaster = Some(broadcaster);
        let database = fixture.database.clone();
        let metrics = CoreMetrics::new("scraper-authority-store-test", 9090, Registry::new())
            .expect("create test metrics");
        let monitor = ScraperWebSocketMonitor::new_with_authority(
            Url::parse("ws://localhost:1").expect("test URL"),
            fixture.sources.into_values().collect(),
            &metrics,
            true,
        )
        .expect("create authority monitor");
        monitor.authority_active.store(true, Ordering::Release);
        let message = dispatch_message(7, b"payload");
        let input = ParityInput::Dispatch {
            block_number: 100,
            message: message.clone(),
            transaction_id: dispatch_transaction_id(),
        };

        assert_eq!(
            monitor.observe_parity(5, EventKind::Dispatch, input).await,
            ParityResult::Match.label()
        );
        assert_eq!(
            notifications.try_recv().expect("dispatch notification"),
            IndexingNotification {
                tx_id: dispatch_transaction_id(),
                sequences: vec![Some(message.nonce)],
            }
        );
        assert_eq!(
            database
                .retrieve_message_by_nonce(7)
                .expect("read stored message"),
            Some(message.clone())
        );
        assert_eq!(
            HyperlaneDb::retrieve_dispatched_tx_hash_by_message_id(&database, &message.id())
                .expect("read stored transaction ID"),
            Some(dispatch_transaction_id())
        );
    }

    #[test]
    fn repairs_partial_merkle_insertion_before_reporting_duplicate() {
        let fixture = fixture();
        let insertion = MerkleTreeInsertion::new(7, H256::from_low_u64_be(42));
        fixture
            .database
            .store_merkle_tree_insertion_by_leaf_index(&7, &insertion)
            .expect("store interrupted primary insertion");

        assert!(!fixture
            .database
            .process_tree_insertion(&insertion, 100)
            .expect("repair partial insertion"));
        assert_eq!(
            fixture
                .database
                .retrieve_merkle_leaf_index_by_message_id(&insertion.message_id())
                .expect("read repaired reverse index"),
            Some(7)
        );
        assert_eq!(
            HyperlaneDb::retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                &fixture.database,
                &7,
            )
            .expect("read repaired block number"),
            Some(100)
        );
    }

    #[test]
    fn repairs_missing_merkle_reverse_index_on_parity_match() {
        let fixture = fixture();
        let insertion = MerkleTreeInsertion::new(7, H256::from_low_u64_be(42));
        fixture
            .database
            .store_merkle_tree_insertion_by_leaf_index(&7, &insertion)
            .expect("store interrupted primary insertion");
        fixture
            .database
            .store_merkle_tree_insertion_block_number_by_leaf_index(&7, &100)
            .expect("store interrupted insertion block");

        assert_eq!(
            fixture.sources[&5]
                .store_sequenced_event(&ParityInput::MerkleTreeInsertion {
                    block_number: 100,
                    insertion,
                })
                .expect("repair matched scraper insertion"),
            None
        );
        assert_eq!(
            fixture
                .database
                .retrieve_merkle_leaf_index_by_message_id(&insertion.message_id())
                .expect("read repaired reverse index"),
            Some(7)
        );
    }

    #[test]
    fn serializes_conflicting_merkle_insertions_across_db_clones() {
        let fixture = fixture();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let insertions = [
            (MerkleTreeInsertion::new(7, H256::from_low_u64_be(41)), 100),
            (MerkleTreeInsertion::new(7, H256::from_low_u64_be(42)), 101),
        ];
        std::thread::scope(|scope| {
            for (insertion, block_number) in insertions {
                let database = fixture.database.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    database
                        .process_tree_insertion(&insertion, block_number)
                        .expect("store concurrent Merkle insertion");
                });
            }
        });

        let stored =
            HyperlaneDb::retrieve_merkle_tree_insertion_by_leaf_index(&fixture.database, &7)
                .expect("read winning insertion")
                .expect("winning insertion exists");
        let (loser, expected_block) = if stored == insertions[0].0 {
            (insertions[1].0, insertions[0].1)
        } else {
            assert_eq!(stored, insertions[1].0);
            (insertions[0].0, insertions[1].1)
        };
        assert_eq!(
            fixture
                .database
                .retrieve_merkle_leaf_index_by_message_id(&stored.message_id())
                .expect("read winning reverse index"),
            Some(7)
        );
        assert_eq!(
            fixture
                .database
                .retrieve_merkle_leaf_index_by_message_id(&loser.message_id())
                .expect("read losing reverse index"),
            None
        );
        assert_eq!(
            HyperlaneDb::retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                &fixture.database,
                &7,
            )
            .expect("read winning block number"),
            Some(expected_block)
        );
    }

    #[test]
    fn repairs_missing_indexed_gas_payment_block() {
        let fixture = fixture();
        let payment = InterchainGasPayment {
            message_id: H256::from_low_u64_be(9),
            destination: 10,
            payment: U256::one(),
            gas_amount: U256::one(),
        };
        let meta = LogMeta {
            address: H256::from_low_u64_be(3),
            block_number: 100,
            block_hash: H256::from_low_u64_be(100),
            transaction_id: H512::from_low_u64_be(1),
            transaction_index: 0,
            log_index: U256::from(7),
        };
        assert!(fixture
            .database
            .process_gas_payment(payment, &meta)
            .expect("store aggregate before simulated interruption"));
        fixture
            .database
            .store_gas_payment_by_sequence(&7, &payment)
            .expect("store interrupted sequence payload");
        assert_eq!(
            fixture
                .database
                .retrieve_gas_payment_block_by_sequence(&7)
                .expect("read missing block"),
            None
        );

        assert!(!fixture
            .database
            .process_indexed_gas_payment(Indexed::new(payment).with_sequence(7), &meta)
            .expect("repair indexed gas payment"));
        assert_eq!(
            fixture
                .database
                .retrieve_gas_payment_block_by_sequence(&7)
                .expect("read repaired block"),
            Some(100)
        );
    }

    #[test]
    fn rejects_conflicting_indexed_gas_payment_sequence() {
        let fixture = fixture();
        let stored_payment = InterchainGasPayment {
            message_id: H256::from_low_u64_be(8),
            destination: 10,
            payment: U256::one(),
            gas_amount: U256::one(),
        };
        let incoming_payment = InterchainGasPayment {
            message_id: H256::from_low_u64_be(9),
            ..stored_payment
        };
        let meta = LogMeta {
            address: H256::from_low_u64_be(3),
            block_number: 100,
            block_hash: H256::from_low_u64_be(100),
            transaction_id: H512::from_low_u64_be(1),
            transaction_index: 0,
            log_index: U256::from(7),
        };
        fixture
            .database
            .store_gas_payment_by_sequence(&7, &stored_payment)
            .expect("store conflicting sequence payment");
        fixture
            .database
            .store_gas_payment_block_by_sequence(&7, &100)
            .expect("store conflicting sequence block");

        assert!(fixture
            .database
            .process_indexed_gas_payment(Indexed::new(incoming_payment).with_sequence(7), &meta)
            .expect_err("conflicting sequence must fail")
            .to_string()
            .contains("conflicts with stored payment"));
        assert_eq!(
            fixture
                .database
                .retrieve_gas_payment_by_gas_payment_key(incoming_payment.into())
                .expect("read untouched incoming aggregate"),
            None
        );
    }

    #[test]
    fn serializes_concurrent_gas_payment_aggregation_across_db_clones() {
        const WRITERS: u32 = 16;
        let fixture = fixture();
        let barrier = Arc::new(std::sync::Barrier::new(WRITERS as usize));
        let payment = InterchainGasPayment {
            message_id: H256::from_low_u64_be(9),
            destination: 10,
            payment: U256::one(),
            gas_amount: U256::one(),
        };
        std::thread::scope(|scope| {
            for index in 0..WRITERS {
                let database = fixture.database.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    database
                        .process_indexed_gas_payment(
                            Indexed::new(payment).with_sequence(index),
                            &LogMeta {
                                address: H256::from_low_u64_be(3),
                                block_number: 100 + u64::from(index),
                                block_hash: H256::from_low_u64_be(100 + u64::from(index)),
                                transaction_id: H512::from_low_u64_be(1 + u64::from(index)),
                                transaction_index: 0,
                                log_index: U256::from(index),
                            },
                        )
                        .expect("store concurrent gas payment");
                });
            }
        });

        let total = fixture
            .database
            .retrieve_gas_payment_by_gas_payment_key(payment.into())
            .expect("read aggregate")
            .expect("aggregate exists");
        assert_eq!(total.payment, U256::from(WRITERS));
        assert_eq!(total.gas_amount, U256::from(WRITERS));
    }

    #[test]
    fn authority_stores_gas_payment_before_its_cursor() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let mut event = gas_payment_event(10);
        event.data["sequence"] = serde_json::json!("7");
        let mut state = StreamState::default();
        state
            .accept_gas_payment_caught_up(
                &scraper_address(source.interchain_gas_paymaster),
                5,
                None,
                Some("9"),
                None,
                &fixture.sources,
            )
            .expect("set gas payment baseline");
        let input = state
            .validate(event, &fixture.sources)
            .expect("validate gas payment")
            .gas_payment
            .expect("gas payment input");

        source.store_gas_payment(&input).expect("store gas payment");
        assert!(source
            .cursor_db
            .retrieve_gas_payment_by_sequence(&7)
            .expect("read gas payment")
            .is_some());
        assert_eq!(
            source.gas_payment_cursor().expect("read stream cursor"),
            None
        );
    }

    fn event(
        event_type: &str,
        sequence: u32,
        data: serde_json::Value,
    ) -> EventMessage<serde_json::Value> {
        EventMessage {
            data,
            domain: 5,
            event_type: event_type.to_owned(),
            legacy_max_stream_cursor: None,
            row_id: None,
            stream_cursor: None,
            sequence: Some(sequence.to_string()),
        }
    }

    fn dispatch_message(nonce: u32, body: &[u8]) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            origin: 5,
            sender: H256::from_low_u64_be(3),
            destination: 6,
            recipient: H256::from_low_u64_be(4),
            body: body.to_vec(),
        }
    }

    fn dispatch_data(nonce: u32, body: &[u8]) -> serde_json::Value {
        let message = dispatch_message(nonce, body);
        serde_json::json!({
            "destination_domain": message.destination,
            "id": "42",
            "msg_body": format!("\\x{}", hex::encode(&message.body)),
            "msg_id": format!("{:#x}", message.id()),
            "nonce": nonce,
            "origin_block_hash": format!("{:#x}", H256::from_low_u64_be(5)),
            "origin_block_height": "100",
            "origin_domain": message.origin,
            "origin_mailbox": format!("{:#x}", H256::from_low_u64_be(1)),
            "origin_tx_hash": format!("\\x{}", hex::encode([6_u8; 32])),
            "recipient": format!("{:#x}", message.recipient),
            "sender": format!("{:#x}", message.sender),
            "time_created": "2026-08-30T00:00:00.000Z",
        })
    }

    fn dispatch_transaction_id() -> H512 {
        bytes_to_h512(&[6_u8; 32])
    }

    fn store_dispatch(database: &HyperlaneRocksDB, message: &HyperlaneMessage) {
        let message_id = message.id();
        database
            .store_message_id_by_nonce(&message.nonce, &message_id)
            .expect("store message ID");
        database
            .store_message_by_id(&message_id, message)
            .expect("store message");
        database
            .store_dispatched_block_number_by_nonce(&message.nonce, &100)
            .expect("store dispatch block");
        database
            .store_dispatched_tx_hash_by_message_id(&message_id, &dispatch_transaction_id())
            .expect("store dispatch transaction");
    }

    fn dispatch_parity_result(local_transaction_id: Option<H512>) -> ParityResult {
        let message = dispatch_message(7, b"payload");
        let local_message = message.clone();
        let mut database = MockParityDatabase::new();
        database
            .expect_retrieve_message_by_nonce()
            .times(1)
            .return_once(move |_| Ok(Some(local_message)));
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(1)
            .return_once(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(1)
            .return_once(move |_| Ok(local_transaction_id));

        ParityInput::Dispatch {
            block_number: 100,
            message,
            transaction_id: dispatch_transaction_id(),
        }
        .compare(&database)
        .expect("compare dispatch parity")
    }

    fn sequence(validated: ValidatedEvent) -> (EventKind, SequenceResult) {
        (validated.kind, validated.sequence_result)
    }

    fn merkle_data(index: u32, hook: H256) -> serde_json::Value {
        merkle_data_for(index, hook, H256::from_low_u64_be(7), 101)
    }

    fn gas_payment_event(row_id: u64) -> EventMessage<serde_json::Value> {
        gas_payment_event_with_boundary(row_id, 0)
    }

    fn gas_payment_event_with_boundary(
        row_id: u64,
        legacy_max_stream_cursor: u64,
    ) -> EventMessage<serde_json::Value> {
        EventMessage {
            data: serde_json::json!({
                "destination": 6,
                "domain": 5,
                "gas_amount": "50000",
                "id": row_id.to_string(),
                "interchain_gas_paymaster": format!("{:#x}", H256::from_low_u64_be(3)),
                "log_index": "0",
                "msg_id": format!("{:#x}", H256::from_low_u64_be(7)),
                "origin": 5,
                "origin_block_hash": format!("{:#x}", H256::from_low_u64_be(8)),
                "origin_block_height": "100",
                "origin_tx_hash": format!("{:#x}", H256::from_low_u64_be(9)),
                "payment": "1000",
                "sequence": null,
                "time_created": "2026-08-30T00:00:00.000Z",
                "tx_id": "42"
            }),
            domain: 5,
            event_type: GAS_PAYMENT_EVENT_TYPE.to_owned(),
            legacy_max_stream_cursor: Some(legacy_max_stream_cursor.to_string()),
            row_id: Some(row_id.to_string()),
            stream_cursor: Some(row_id.to_string()),
            sequence: None,
        }
    }

    fn wire_event(event: EventMessage<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "data": event.data,
            "domain": event.domain,
            "eventType": event.event_type,
            "legacyMaxStreamCursor": event.legacy_max_stream_cursor,
            "rowId": event.row_id,
            "streamCursor": event.stream_cursor,
            "sequence": event.sequence,
            "type": "event",
        })
    }

    fn proxy_subscription_response(request: &serde_json::Value) -> serde_json::Value {
        let mut streams = request["streams"].clone();
        for stream in streams.as_array_mut().expect("subscription streams") {
            for cursor in stream["cursors"]
                .as_array_mut()
                .expect("subscription cursors")
            {
                cursor
                    .as_object_mut()
                    .expect("subscription cursor")
                    .remove("allowReplay");
            }
        }
        streams
    }

    fn merkle_data_for(
        index: u32,
        hook: H256,
        message_id: H256,
        block_number: u64,
    ) -> serde_json::Value {
        serde_json::json!({
            "block_number": block_number.to_string(),
            "domain": 5,
            "leaf_index": index,
            "merkle_tree_hook": format!("{hook:#x}"),
            "message_id": format!("{message_id:#x}"),
        })
    }

    fn gas_payment_cursors() -> Vec<SubscribedCursor> {
        vec![SubscribedCursor {
            address: scraper_address(H256::from_low_u64_be(3)),
            after_stream_cursor: None,
            after_sequence: None,
            domain: 5,
        }]
    }

    fn replay_plan(sources: &HashMap<u32, ScraperSource>) -> SequencedReplayPlan {
        SequencedReplayPlan::load(sources).expect("replay plan")
    }

    fn replay_state(plan: &SequencedReplayPlan) -> StreamState {
        let mut state = StreamState::default();
        state.reset_sequenced(plan);
        state
    }

    fn subscribed_streams(
        sources: &HashMap<u32, ScraperSource>,
        plan: &SequencedReplayPlan,
    ) -> Vec<SubscribedStream> {
        let mut sources = sources.values().collect::<Vec<_>>();
        sources.sort_unstable_by_key(|source| source.domain);
        let domains = sources
            .iter()
            .map(|source| source.domain)
            .collect::<Vec<_>>();
        let mut streams = [EventKind::Dispatch, EventKind::MerkleTreeInsertion]
            .into_iter()
            .map(|kind| SubscribedStream {
                cursors: Some(
                    sequenced_subscription_cursors(sources.as_slice(), kind, plan)
                        .expect("cursor read"),
                ),
                domains: Some(domains.clone()),
                event_type: kind.label().to_owned(),
                stream_cursor_version: None,
            })
            .collect::<Vec<_>>();
        streams.push(SubscribedStream {
            cursors: Some(
                sources
                    .iter()
                    .map(|source| SubscribedCursor {
                        address: scraper_address(source.interchain_gas_paymaster),
                        after_stream_cursor: None,
                        after_sequence: None,
                        domain: source.domain,
                    })
                    .collect(),
            ),
            domains: Some(domains),
            event_type: GAS_PAYMENT_EVENT_TYPE.to_owned(),
            stream_cursor_version: Some(GAS_PAYMENT_STREAM_CURSOR_VERSION),
        });
        streams
    }

    #[test]
    fn sequenced_reset_preserves_gas_state() {
        let sources = sources();
        let plan = replay_plan(&sources);
        let cursor = DurableGasPaymentCursor {
            fingerprint: Some(H256::from_low_u64_be(9)),
            legacy_max_stream_cursor: 20,
            stream_cursor: 41,
        };
        let mut state = StreamState::default();
        state.cursors.insert(
            (5, EventKind::Dispatch),
            StreamCursor::from_durable_sequence(99),
        );
        state.gas_payment_degraded.insert(5);
        state.gas_payment_rows.insert(5, cursor);

        state.reset_sequenced(&plan);

        assert!(state.cursors.is_empty());
        assert_eq!(state.gas_payment_degraded, HashSet::from([5]));
        assert_eq!(state.gas_payment_rows, HashMap::from([(5, cursor)]));
    }

    #[test]
    fn reconnect_rebuilds_sequenced_plan_without_changing_gas_resume() {
        let fixture = fixture();
        let sources = &fixture.sources;
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 100)
            .expect("store dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 90)
            .expect("store Merkle cursor");
        source
            .store_gas_payment_cursor(&DurableGasPaymentCursor {
                fingerprint: Some(H256::from_low_u64_be(9)),
                legacy_max_stream_cursor: 20,
                stream_cursor: 41,
            })
            .expect("store gas cursor");
        let mut state = StreamState::load_gas_payment(sources).expect("load gas state");
        let initial_plan = replay_plan(sources);
        state.reset_sequenced(&initial_plan);
        let initial_gas = vec![SubscribedCursor {
            address: scraper_address(source.interchain_gas_paymaster),
            after_stream_cursor: Some("41".to_owned()),
            after_sequence: None,
            domain: 5,
        }];
        let initial: serde_json::Value = serde_json::to_value(
            &subscription(sources, &initial_plan, &initial_gas, true)
                .expect("initial subscription"),
        )
        .expect("initial subscription JSON");
        assert_eq!(initial["streams"][0]["cursors"][0]["afterSequence"], "99");
        assert_eq!(
            initial["streams"][2]["cursors"][0]["afterStreamCursor"],
            "41"
        );

        source
            .store_cursor(EventKind::MerkleTreeInsertion, 100)
            .expect("advance Merkle cursor");
        let reconnect_plan = replay_plan(sources);
        state.reset_sequenced(&reconnect_plan);
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 41);
        let reconnect: serde_json::Value = serde_json::to_value(
            &subscription(sources, &reconnect_plan, &initial_gas, true)
                .expect("reconnect subscription"),
        )
        .expect("reconnect subscription JSON");
        assert_eq!(reconnect["streams"][0]["cursors"][0]["afterSequence"], "99");
        assert_eq!(
            reconnect["streams"][2]["cursors"][0]["afterStreamCursor"],
            "41"
        );
    }

    #[test]
    fn preserves_sequence_across_reconnects() {
        let fixture = fixture();
        let sources = &fixture.sources;
        let mut contiguous = StreamState::default();

        assert_eq!(
            sequence(
                contiguous
                    .validate(
                        event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                        sources,
                    )
                    .expect("first event"),
            ),
            (EventKind::Dispatch, SequenceResult::Accepted)
        );
        assert_eq!(
            sequence(
                contiguous
                    .validate(
                        event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                        sources,
                    )
                    .expect("duplicate event after reconnect"),
            ),
            (EventKind::Dispatch, SequenceResult::Duplicate)
        );
        assert_eq!(
            sequence(
                contiguous
                    .validate(
                        event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"eight")),
                        sources,
                    )
                    .expect("next event after reconnect"),
            ),
            (EventKind::Dispatch, SequenceResult::Accepted)
        );

        let mut gapped = StreamState::default();
        gapped
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                sources,
            )
            .expect("first event before reconnect");
        assert!(gapped
            .validate(
                event(DISPATCH_EVENT_TYPE, 9, dispatch_data(9, b"nine")),
                sources,
            )
            .expect_err("gap must reject")
            .to_string()
            .contains("expected sequence 8"));
    }

    #[test]
    fn replayed_boundary_keeps_its_actual_sequence() {
        let fixture = fixture();
        let mut state = StreamState::default();
        for sequence in 7..=20 {
            state
                .validate(
                    event(
                        DISPATCH_EVENT_TYPE,
                        sequence,
                        dispatch_data(sequence, &sequence.to_be_bytes()),
                    ),
                    &fixture.sources,
                )
                .expect("contiguous dispatch event");
        }

        let replayed = state
            .validate(
                event(
                    DISPATCH_EVENT_TYPE,
                    7,
                    dispatch_data(7, &7_u32.to_be_bytes()),
                ),
                &fixture.sources,
            )
            .expect("replayed boundary event");

        assert_eq!(replayed.sequence_result, SequenceResult::Duplicate);
        assert_eq!(replayed.sequence, Some(7));
        assert_eq!(
            state
                .latest_sequence(5, EventKind::Dispatch)
                .expect("latest sequence"),
            20
        );
    }

    #[test]
    fn restores_durable_sequence_after_process_restart() {
        let sources = sources();
        let initial_plan = replay_plan(&sources);
        let mut first_process = replay_state(&initial_plan);
        first_process
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("persist first event");
        sources[&5]
            .store_cursor(EventKind::Dispatch, 7)
            .expect("store first event cursor");

        let restart_plan = replay_plan(&sources);
        let mut restarted = replay_state(&restart_plan);
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("replay durable boundary");
        assert!(restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 9, dispatch_data(9, b"nine")),
                &sources,
            )
            .expect_err("restart gap must reject")
            .to_string()
            .contains("expected sequence 8"));
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"eight")),
                &sources,
            )
            .expect("replayed event after durable cursor");
    }

    #[test]
    fn fresh_positive_baseline_rejects_staged_sequence_gaps() {
        let event_for = |kind, sequence| match kind {
            EventKind::Dispatch => event(
                DISPATCH_EVENT_TYPE,
                sequence,
                dispatch_data(sequence, b"message"),
            ),
            EventKind::MerkleTreeInsertion => event(
                MERKLE_EVENT_TYPE,
                sequence,
                merkle_data_for(
                    sequence,
                    H256::from_low_u64_be(2),
                    dispatch_message(sequence, b"message").id(),
                    100,
                ),
            ),
            EventKind::GasPayment => unreachable!("gas payments are not sequenced parity events"),
        };

        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            let sources = sources();
            let source = &sources[&5];
            let mut state = StreamState::default();
            let validated = state
                .validate(event_for(kind, 102), &sources)
                .expect("stage event after a gap");
            let mut staged = StagedParity::default();
            staged.push(5, validated).expect("stage parity");

            assert!(state
                .validate_fresh_baseline(5, kind, 100)
                .expect_err("fresh event must immediately follow its marker")
                .to_string()
                .contains("expected 101"));
            assert_eq!(staged.len, 1, "rejected parity remains unadmitted");
            assert_eq!(source.cursor(kind).expect("stream cursor"), None);

            let mut contiguous = StreamState::default();
            contiguous
                .validate(event_for(kind, 101), &sources)
                .expect("stage contiguous event");
            contiguous
                .validate_fresh_baseline(5, kind, 100)
                .expect("baseline accepts its immediate successor");
        }

        StreamState::default()
            .validate_fresh_baseline(5, EventKind::Dispatch, 100)
            .expect("a stream without staged events may catch up at any positive marker");
    }

    #[test]
    fn staged_empty_parity_drains_only_complete_prefix() {
        let sources = sources();
        let plan = replay_plan(&sources);
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), -1),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);
        let mut state = replay_state(&plan);
        let mut staged = StagedParity::default();
        for validated in [
            state
                .validate(
                    event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, b"zero")),
                    &sources,
                )
                .expect("dispatch zero"),
            state
                .validate(
                    event(DISPATCH_EVENT_TYPE, 1, dispatch_data(1, b"one")),
                    &sources,
                )
                .expect("dispatch one"),
            state
                .validate(
                    event(
                        MERKLE_EVENT_TYPE,
                        0,
                        merkle_data_for(
                            0,
                            H256::from_low_u64_be(2),
                            dispatch_message(0, b"zero").id(),
                            100,
                        ),
                    ),
                    &sources,
                )
                .expect("Merkle zero"),
        ] {
            staged.push(5, validated).expect("stage parity");
        }
        let ready = staged
            .drain_ready(&plan, &caught_up, &state, 5)
            .expect("drain complete prefix")
            .into_iter()
            .map(|event| (event.kind, event.sequence))
            .collect::<Vec<_>>();
        assert_eq!(
            ready,
            vec![
                (EventKind::Dispatch, 0),
                (EventKind::Dispatch, 1),
                (EventKind::MerkleTreeInsertion, 0),
            ]
        );
        assert_eq!(staged.len, 0);

        staged
            .push(
                5,
                state
                    .validate(
                        event(
                            MERKLE_EVENT_TYPE,
                            1,
                            merkle_data_for(
                                1,
                                H256::from_low_u64_be(2),
                                dispatch_message(1, b"one").id(),
                                100,
                            ),
                        ),
                        &sources,
                    )
                    .expect("Merkle one"),
            )
            .expect("stage parity");
        assert_eq!(
            staged
                .drain_ready(&plan, &caught_up, &state, 5)
                .expect("drain next ready event")
                .into_iter()
                .map(|event| (event.kind, event.sequence))
                .collect::<Vec<_>>(),
            vec![(EventKind::MerkleTreeInsertion, 1)]
        );
        assert_eq!(staged.len, 0);
    }

    #[test]
    fn staged_nonzero_empty_start_never_becomes_ready() {
        let sources = sources();
        let plan = replay_plan(&sources);
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), -1),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);
        let mut state = replay_state(&plan);
        let mut staged = StagedParity::default();
        staged
            .push(
                5,
                state
                    .validate(
                        event(DISPATCH_EVENT_TYPE, 5, dispatch_data(5, b"five")),
                        &sources,
                    )
                    .expect("stage pre-marker nonzero event"),
            )
            .expect("stage parity");
        assert!(staged
            .drain_ready(&plan, &caught_up, &state, 5)
            .expect_err("empty stream must begin at zero")
            .to_string()
            .contains("expected 0"));
        assert_eq!(staged.len, 1, "invalid staged event remains unadmitted");
    }

    #[test]
    fn fresh_empty_merkle_can_advance_while_waiting_for_dispatch() {
        let sources = sources();
        let plan = replay_plan(&sources);
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), -1),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);
        let mut state = replay_state(&plan);
        for sequence in 0..=1 {
            state
                .validate(
                    event(
                        MERKLE_EVENT_TYPE,
                        sequence,
                        merkle_data_for(
                            sequence,
                            H256::from_low_u64_be(2),
                            dispatch_message(sequence, &[sequence as u8]).id(),
                            100,
                        ),
                    ),
                    &sources,
                )
                .expect("Merkle event while dispatch is pending");
            assert!(sequenced_persistence_ready(
                &plan,
                &caught_up,
                &state,
                5,
                EventKind::MerkleTreeInsertion,
                sequence,
            )
            .expect("persistence readiness"));
        }

        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, &[0])),
                &sources,
            )
            .expect("first dispatch event");
        assert!(
            sequenced_persistence_ready(&plan, &caught_up, &state, 5, EventKind::Dispatch, 0,)
                .expect("persistence readiness")
        );
    }

    #[test]
    fn fresh_empty_peer_marker_rejects_staged_nonzero_start() {
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            let sources = sources();
            let plan = replay_plan(&sources);
            let mut state = replay_state(&plan);
            let first = match kind {
                EventKind::Dispatch => event(DISPATCH_EVENT_TYPE, 5, dispatch_data(5, &[5])),
                EventKind::MerkleTreeInsertion => event(
                    MERKLE_EVENT_TYPE,
                    5,
                    merkle_data_for(
                        5,
                        H256::from_low_u64_be(2),
                        dispatch_message(5, &[5]).id(),
                        100,
                    ),
                ),
                EventKind::GasPayment => unreachable!("test only covers sequenced streams"),
            };
            state
                .validate(first, &sources)
                .expect("staged first nonzero event");
            let peer = match kind {
                EventKind::Dispatch => EventKind::MerkleTreeInsertion,
                EventKind::MerkleTreeInsertion => EventKind::Dispatch,
                EventKind::GasPayment => unreachable!("test only covers sequenced streams"),
            };
            let mut caught_up = HashMap::from([((5, kind), -1)]);
            assert!(!source_caught_up(&caught_up, &state, 5).expect("one empty marker"));
            caught_up.insert((5, peer), -1);
            assert!(source_caught_up(&caught_up, &state, 5)
                .expect_err("peer marker must reject staged nonzero start")
                .to_string()
                .contains("expected 0"));
        }
    }

    #[test]
    fn connection_plan_is_immutable_when_durable_cursors_advance() {
        let sources = sources();
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 100)
            .expect("store dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 90)
            .expect("store Merkle cursor");
        let plan = replay_plan(&sources);
        let request: serde_json::Value = serde_json::to_value(
            &subscription(&sources, &plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");

        source
            .store_cursor(EventKind::Dispatch, 200)
            .expect("advance dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 200)
            .expect("advance Merkle cursor");
        assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "99");
        assert_eq!(request["streams"][1]["cursors"][0]["afterSequence"], "89");
        let streams = subscribed_streams(&sources, &plan);
        validate_subscription(&streams, &sources, &plan, &gas_payment_cursors(), true)
            .expect("subscription confirmation uses captured plan");
        validate_caught_up_floor(&plan, 5, EventKind::MerkleTreeInsertion, 90)
            .expect("captured replay floor");
        assert!(validate_caught_up_floor(&plan, 5, EventKind::MerkleTreeInsertion, 89).is_err());
    }

    #[test]
    fn replay_includes_zero_boundary() {
        assert_eq!(replay_after_sequence(0), "-1");
        assert_eq!(replay_after_sequence(1), "0");
    }

    #[test]
    fn rejects_conflicting_duplicate_dispatch() {
        let fixture = fixture();
        let sources = &fixture.sources;
        let mut state = StreamState::default();
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"original")),
                sources,
            )
            .expect("first event");

        assert!(state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"conflict")),
                sources,
            )
            .expect_err("conflicting duplicate must reject")
            .to_string()
            .contains("Conflicting scraper event"));
    }

    #[test]
    fn dispatch_parity_handles_lag_duplicate_restart_and_conflict() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let message = dispatch_message(7, b"payload");
        let data = dispatch_data(7, b"payload");
        let mut state = StreamState::default();

        let lagging = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, data.clone()),
                &fixture.sources,
            )
            .expect("lagging event");
        assert_eq!(
            lagging
                .parity
                .expect("dispatch parity")
                .compare(source.database.as_ref())
                .expect("lag comparison"),
            ParityResult::Missing
        );

        store_dispatch(&fixture.database, &message);
        let duplicate = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, data.clone()),
                &fixture.sources,
            )
            .expect("duplicate event");
        assert_eq!(duplicate.sequence_result, SequenceResult::Duplicate);
        assert_eq!(
            duplicate
                .parity
                .expect("dispatch parity")
                .compare(source.database.as_ref())
                .expect("duplicate parity"),
            ParityResult::Match
        );

        let restarted = StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, data), &fixture.sources)
            .expect("event after process restart");
        assert_eq!(restarted.sequence_result, SequenceResult::Accepted);
        assert_eq!(
            restarted
                .parity
                .expect("dispatch parity")
                .compare(source.database.as_ref())
                .expect("restart parity"),
            ParityResult::Match
        );

        let mut conflict_data = dispatch_data(7, b"payload");
        conflict_data["origin_block_height"] = serde_json::json!("101");
        let conflict = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, conflict_data),
                &fixture.sources,
            )
            .expect("conflicting event payload");
        assert_eq!(
            conflict
                .parity
                .expect("dispatch parity")
                .compare(source.database.as_ref())
                .expect("conflict parity"),
            ParityResult::Conflict
        );
    }

    #[test]
    fn dispatch_parity_accepts_unknown_local_transaction_id() {
        assert_eq!(
            dispatch_parity_result(Some(H512::zero())),
            ParityResult::Match
        );
    }

    #[test]
    fn dispatch_parity_rejects_known_transaction_id_mismatch() {
        assert_eq!(
            dispatch_parity_result(Some(bytes_to_h512(&[7_u8; 32]))),
            ParityResult::Conflict
        );
    }

    #[test]
    fn dispatch_parity_requires_local_transaction_id_entry() {
        assert_eq!(dispatch_parity_result(None), ParityResult::Missing);
    }

    #[test]
    fn dispatch_parity_survives_database_restart() {
        let temp_dir = tempfile::tempdir().expect("temp DB directory");
        let message = dispatch_message(7, b"payload");
        {
            let db = DB::from_path(temp_dir.path()).expect("open temp DB");
            let database =
                HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("scraper-parity"), db);
            store_dispatch(&database, &message);
        }

        let db = DB::from_path(temp_dir.path()).expect("reopen temp DB");
        let database =
            HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("scraper-parity"), db);
        let sources = HashMap::from([(5, source(database))]);
        let validated = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &sources,
            )
            .expect("dispatch after restart");

        assert_eq!(
            validated
                .parity
                .expect("dispatch parity")
                .compare(sources.get(&5).expect("source").database.as_ref())
                .expect("restart comparison"),
            ParityResult::Match
        );
    }

    #[tokio::test]
    async fn one_shot_db_error_does_not_interrupt_next_event() {
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut database = MockParityDatabase::new();
        database
            .expect_retrieve_message_by_nonce()
            .times(2)
            .returning({
                let calls = calls.clone();
                move |nonce| {
                    if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        Err(hyperlane_base::db::DbError::Other(
                            "one-shot read failure".to_owned(),
                        ))
                    } else {
                        Ok(Some(dispatch_message(nonce, b"next")))
                    }
                }
            });
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(1)
            .returning(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(1)
            .returning(|_| Ok(Some(dispatch_transaction_id())));
        let monitor = monitor(std::sync::Arc::new(database));
        monitor.set_active(true);
        let mut state = StreamState::default();

        let first = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"first")),
                &monitor.sources,
            )
            .expect("first event");
        monitor
            .observe_parity(5, first.kind, first.parity.expect("dispatch parity"))
            .await;

        let next = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"next")),
                &monitor.sources,
            )
            .expect("next event on the same stream");
        assert_eq!(next.sequence_result, SequenceResult::Accepted);
        monitor
            .observe_parity(5, next.kind, next.parity.expect("dispatch parity"))
            .await;

        assert_eq!(
            monitor
                .parity
                .with_label_values(&["test", DISPATCH_EVENT_TYPE, "error"])
                .get(),
            1
        );
        assert_eq!(
            monitor
                .parity
                .with_label_values(&["test", DISPATCH_EVENT_TYPE, "match"])
                .get(),
            1
        );
        assert_eq!(monitor.active.with_label_values(&["test"]).get(), 1);
        assert_eq!(
            monitor
                .parity_ready
                .with_label_values(&["test", DISPATCH_EVENT_TYPE])
                .get(),
            0
        );
    }

    #[tokio::test]
    async fn retries_missing_parity_until_the_local_db_matches() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut database = MockParityDatabase::new();
        database
            .expect_retrieve_message_by_nonce()
            .times(2)
            .returning({
                let calls = calls.clone();
                move |nonce| {
                    if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                        Ok(None)
                    } else {
                        Ok(Some(dispatch_message(nonce, b"payload")))
                    }
                }
            });
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(2)
            .returning(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(2)
            .returning(|_| Ok(Some(dispatch_transaction_id())));
        let monitor = monitor(Arc::new(database));
        let input = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &monitor.sources,
            )
            .expect("valid dispatch")
            .parity
            .expect("dispatch parity");

        monitor.observe_parity(5, EventKind::Dispatch, input).await;

        assert_eq!(
            monitor
                .parity
                .with_label_values(&["test", DISPATCH_EVENT_TYPE, "match"])
                .get(),
            1
        );
        assert_eq!(
            monitor
                .parity_pending
                .with_label_values(&["test", DISPATCH_EVENT_TYPE])
                .get(),
            0
        );
        assert_eq!(
            monitor
                .parity_ready
                .with_label_values(&["test", DISPATCH_EVENT_TYPE])
                .get(),
            1
        );
    }

    #[tokio::test]
    async fn staged_event_clears_parity_readiness_until_terminal() {
        let mut database = MockParityDatabase::new();
        database
            .expect_retrieve_message_by_nonce()
            .times(1)
            .returning(|nonce| Ok(Some(dispatch_message(nonce, b"matched"))));
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(1)
            .returning(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(1)
            .returning(|_| Ok(Some(dispatch_transaction_id())));
        let monitor = Arc::new(monitor(Arc::new(database)));
        let labels = ["test", DISPATCH_EVENT_TYPE];
        let mut state = StreamState::default();
        let matched = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, b"matched")),
                &monitor.sources,
            )
            .expect("valid matched dispatch");
        assert_eq!(
            monitor
                .observe_parity(
                    5,
                    matched.kind,
                    matched.parity.expect("sequenced parity input"),
                )
                .await,
            ParityResult::Match.label()
        );
        assert_eq!(monitor.parity_pending.with_label_values(&labels).get(), 0);
        assert_eq!(monitor.parity_ready.with_label_values(&labels).get(), 1);

        let staged_event = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 1, dispatch_data(1, b"staged")),
                &monitor.sources,
            )
            .expect("valid staged dispatch");
        let mut staged = StagedParity::default();
        monitor
            .stage_parity(&mut staged, 5, staged_event)
            .expect("stage unmatched dispatch");
        assert_eq!(monitor.parity_pending.with_label_values(&labels).get(), 1);
        assert_eq!(monitor.parity_ready.with_label_values(&labels).get(), 0);

        let queued_event = state
            .validate(
                event(DISPATCH_EVENT_TYPE, 2, dispatch_data(2, b"queued")),
                &monitor.sources,
            )
            .expect("valid queued dispatch");
        monitor.note_parity_pending(5, EventKind::Dispatch);
        let queue = monitor
            .parity_queues
            .get(&(5, EventKind::Dispatch))
            .expect("dispatch queue");
        queue.lock().jobs.push_back(ParityJob {
            input: queued_event.parity.expect("sequenced parity input"),
            queue_permit: monitor
                .parity_queue_permit
                .clone()
                .try_acquire_owned()
                .expect("queue permit"),
            sequence: queued_event.sequence.expect("sequenced wire sequence"),
        });
        assert_eq!(monitor.parity_pending.with_label_values(&labels).get(), 2);

        monitor.abandon_staged_parity(&mut staged);
        assert_eq!(monitor.parity_pending.with_label_values(&labels).get(), 1);
        assert_eq!(monitor.parity_ready.with_label_values(&labels).get(), 0);
        monitor.abandon_parity_queue(5, EventKind::Dispatch, queue);
        assert_eq!(monitor.parity_pending.with_label_values(&labels).get(), 0);
    }

    #[tokio::test]
    async fn queues_parity_without_blocking_the_websocket_reader() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let release = Arc::new((parking_lot::Mutex::new(false), parking_lot::Condvar::new()));
        let mut database = MockParityDatabase::new();
        let read_release = release.clone();
        database
            .expect_retrieve_message_by_nonce()
            .times(1)
            .returning(move |nonce| {
                entered_tx.send(()).expect("record parity read");
                let (released, signal) = read_release.as_ref();
                let mut released = released.lock();
                while !*released {
                    signal.wait(&mut released);
                }
                Ok(Some(dispatch_message(nonce, b"payload")))
            });
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(1)
            .returning(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(1)
            .returning(|_| Ok(Some(dispatch_transaction_id())));
        let monitor = Arc::new(monitor(Arc::new(database)));
        let input = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &monitor.sources,
            )
            .expect("valid dispatch")
            .parity
            .expect("dispatch has parity input");

        timeout(
            Duration::from_millis(100),
            monitor.enqueue_parity(5, EventKind::Dispatch, input, 7),
        )
        .await
        .expect("queue admission must not await the DB read");
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(5)))
            .await
            .expect("wait for blocking parity read")
            .expect("blocking parity read started");
        assert_eq!(
            monitor.sources[&5]
                .cursor(EventKind::Dispatch)
                .expect("cursor read"),
            None
        );

        let (released, signal) = release.as_ref();
        *released.lock() = true;
        signal.notify_all();
        timeout(Duration::from_secs(1), async {
            while monitor.sources[&5]
                .cursor(EventKind::Dispatch)
                .expect("cursor read")
                != Some(7)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("ordered worker persists the terminal cursor");
    }

    #[tokio::test]
    async fn full_parity_queue_restores_other_origin_rpc_fallback() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind server");
        let url =
            Url::parse(&format!("ws://{}", listener.local_addr().expect("address"))).expect("URL");
        let metrics = CoreMetrics::new("parity-backpressure", 0, Registry::new()).expect("metrics");
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new_with_authority(
                url,
                sources_for(&[5, 9]).into_values().collect(),
                &metrics,
                true,
            )
            .expect("monitor"),
        );
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            monitor.sources[&5]
                .store_cursor(kind, 0)
                .expect("replay floor");
        }
        // Origin 5 has no RPC-indexed messages. Its FIFO worker retries Missing
        // while retaining a slot; the remaining jobs consume the global queue.
        for sequence in 1..=u32::try_from(PARITY_QUEUE_CAPACITY).expect("capacity") {
            let validated = StreamState::default()
                .validate(
                    event(
                        DISPATCH_EVENT_TYPE,
                        sequence,
                        dispatch_data(sequence, b"payload"),
                    ),
                    &monitor.sources,
                )
                .expect("valid event");
            assert!(
                monitor
                    .enqueue_parity(
                        5,
                        EventKind::Dispatch,
                        validated.parity.expect("parity"),
                        sequence,
                    )
                    .await
            );
        }
        assert_eq!(monitor.parity_queue_permit.available_permits(), 0);
        let mut receiver = monitor.authority_receiver(9).expect("authority receiver");
        let server_monitor = monitor.clone();
        let (finish_tx, finish_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = accept_async(stream).await.expect("websocket");
            socket
                .send(Message::Text(r#"{"type":"ready"}"#.to_owned()))
                .await
                .expect("ready");
            let request = socket.next().await.expect("subscription").expect("read");
            let request: serde_json::Value =
                serde_json::from_str(request.to_text().expect("text")).expect("JSON");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "type": "subscribed", "streams": proxy_subscription_response(&request),
                    })
                    .to_string(),
                ))
                .await
                .expect("subscribed");
            // Model origin 9 having completed cutover, with RPC indexers paused.
            let authority = server_monitor.source_authority(9);
            authority
                .sender
                .send_modify(|command| command.desired = true);
            authority.active.store(true, Ordering::Release);
            authority
                .handoff
                .mark_paused(9, authority.sender.borrow().generation);
            socket
                .send(Message::Text(
                    wire_event(event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, b"payload")))
                        .to_string(),
                ))
                .await
                .expect("event");
            finish_rx.await.expect("finish");
        });
        let mut state = StreamState::default();
        let err = timeout(Duration::from_millis(250), monitor.stream_once(&mut state))
            .await
            .expect("admission must not wait for Missing retries")
            .expect_err("full queue ends session");
        assert!(err.to_string().contains("parity queue is full"), "{err:?}");
        assert!(!receiver.borrow_and_update().desired);
        assert!(!monitor.source_authority(9).active.load(Ordering::Acquire));
        assert!(!monitor.parity_read_disabled.load(Ordering::Acquire));
        assert_eq!(
            monitor.sources[&5]
                .cursor(EventKind::Dispatch)
                .expect("cursor"),
            Some(0)
        );
        assert_eq!(
            monitor
                .parity_pending
                .with_label_values(&["test-5", DISPATCH_EVENT_TYPE])
                .get(),
            i64::try_from(PARITY_QUEUE_CAPACITY).expect("capacity")
        );
        finish_tx.send(()).expect("finish server");
        server.await.expect("server");
    }

    #[tokio::test]
    async fn processes_parity_in_fifo_admission_order() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let release = Arc::new((parking_lot::Mutex::new(false), parking_lot::Condvar::new()));
        let mut database = MockParityDatabase::new();
        database
            .expect_retrieve_message_by_nonce()
            .times(2)
            .returning({
                let calls = calls.clone();
                let release = release.clone();
                move |nonce| {
                    let call = calls.fetch_add(1, Ordering::SeqCst);
                    if call == 0 {
                        entered_tx.send(()).expect("record first parity read");
                        let (released, signal) = release.as_ref();
                        let mut released = released.lock();
                        while !*released {
                            signal.wait(&mut released);
                        }
                    }
                    let body: &[u8] = if nonce == 7 { b"first" } else { b"second" };
                    Ok(Some(dispatch_message(nonce, body)))
                }
            });
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(2)
            .returning(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(2)
            .returning(|_| Ok(Some(dispatch_transaction_id())));
        let monitor = Arc::new(monitor(Arc::new(database)));
        let first = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"first")),
                &monitor.sources,
            )
            .expect("first dispatch");
        let second = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"second")),
                &monitor.sources,
            )
            .expect("second dispatch");

        monitor
            .enqueue_parity(
                5,
                first.kind,
                first.parity.expect("dispatch parity"),
                first.sequence.expect("dispatch sequence"),
            )
            .await;
        tokio::task::spawn_blocking(move || entered_rx.recv_timeout(Duration::from_secs(1)))
            .await
            .expect("wait for first parity read")
            .expect("first parity read started");
        monitor
            .enqueue_parity(
                5,
                second.kind,
                second.parity.expect("dispatch parity"),
                second.sequence.expect("dispatch sequence"),
            )
            .await;
        tokio::task::yield_now().await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            monitor.sources[&5]
                .cursor(EventKind::Dispatch)
                .expect("cursor read"),
            None
        );

        let (released, signal) = release.as_ref();
        *released.lock() = true;
        signal.notify_all();
        timeout(Duration::from_secs(1), async {
            while monitor.sources[&5]
                .cursor(EventKind::Dispatch)
                .expect("cursor read")
                != Some(8)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("FIFO worker persists both terminal cursors");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn four_hung_reads_trip_circuit_without_stalling_later_work() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let release = Arc::new((parking_lot::Mutex::new(false), parking_lot::Condvar::new()));
        let metrics = CoreMetrics::new("scraper-parity-hung-reads", 9090, Registry::new())
            .expect("create test metrics");
        let mut sources = Vec::new();

        for domain in 1..=(PARITY_READ_CONCURRENCY + 1) as u32 {
            let mut database = MockParityDatabase::new();
            if domain <= PARITY_READ_CONCURRENCY as u32 {
                let entered_tx = entered_tx.clone();
                let release = release.clone();
                database
                    .expect_retrieve_message_by_nonce()
                    .times(1)
                    .returning(move |_| {
                        entered_tx.send(()).expect("record hung parity read");
                        let (released, signal) = release.as_ref();
                        let mut released = released.lock();
                        while !*released {
                            signal.wait(&mut released);
                        }
                        Err(hyperlane_base::db::DbError::Other(
                            "released hung read".to_owned(),
                        ))
                    });
            } else {
                database.expect_retrieve_message_by_nonce().times(0);
            }
            sources.push(ScraperSource::with_database(
                format!("test-{domain}"),
                domain,
                H256::from_low_u64_be(1),
                H256::from_low_u64_be(2),
                H256::from_low_u64_be(3),
                Arc::new(database),
            ));
        }
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new(
                Url::parse("ws://localhost:1").expect("test URL"),
                sources,
                &metrics,
            )
            .expect("create test monitor"),
        );
        for source in monitor.sources.values() {
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                monitor
                    .parity_ready
                    .with_label_values(&[source.chain.as_str(), kind.label()])
                    .set(1);
            }
        }
        let parity_input = |domain| ParityInput::Dispatch {
            block_number: 100,
            message: HyperlaneMessage {
                version: 3,
                nonce: domain,
                origin: domain,
                sender: H256::from_low_u64_be(3),
                destination: 6,
                recipient: H256::from_low_u64_be(4),
                body: b"payload".to_vec(),
            },
            transaction_id: dispatch_transaction_id(),
        };

        for domain in 1..=PARITY_READ_CONCURRENCY as u32 {
            monitor
                .enqueue_parity(domain, EventKind::Dispatch, parity_input(domain), domain)
                .await;
        }
        let entered = tokio::task::spawn_blocking(move || {
            (0..PARITY_READ_CONCURRENCY)
                .filter(|_| entered_rx.recv_timeout(Duration::from_secs(1)).is_ok())
                .count()
        })
        .await
        .expect("wait for hung parity reads");
        assert_eq!(entered, PARITY_READ_CONCURRENCY);

        let later_domain = (PARITY_READ_CONCURRENCY + 1) as u32;
        monitor
            .enqueue_parity(
                later_domain,
                EventKind::Dispatch,
                parity_input(later_domain),
                later_domain,
            )
            .await;
        timeout(Duration::from_secs(1), async {
            while monitor.sources[&later_domain]
                .cursor(EventKind::Dispatch)
                .expect("cursor read")
                != Some(later_domain)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("later parity work terminates after circuit opens");
        timeout(Duration::from_secs(1), async {
            while (1..=PARITY_READ_CONCURRENCY as u32).any(|domain| {
                monitor.sources[&domain]
                    .cursor(EventKind::Dispatch)
                    .expect("cursor read")
                    != Some(domain)
            }) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("timed-out parity jobs terminate");
        assert!(monitor.parity_read_disabled.load(Ordering::Acquire));
        for domain in 1..=later_domain {
            let source = &monitor.sources[&domain];
            for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                assert_eq!(
                    monitor
                        .parity_ready
                        .with_label_values(&[source.chain.as_str(), kind.label()])
                        .get(),
                    0
                );
            }
            assert!(source
                .parity_unhealthy(EventKind::Dispatch)
                .expect("durable parity poison"));
        }
        timeout(
            Duration::from_millis(10),
            monitor.enqueue_parity(
                later_domain,
                EventKind::Dispatch,
                parity_input(later_domain),
                later_domain + 1,
            ),
        )
        .await
        .expect("open circuit rejects queue admission immediately");
        assert_eq!(
            monitor.sources[&later_domain]
                .cursor(EventKind::Dispatch)
                .expect("cursor read"),
            Some(later_domain)
        );
        assert_eq!(
            monitor.parity_queue_permit.available_permits(),
            PARITY_QUEUE_CAPACITY
        );
        assert_eq!(monitor.parity_read_permit.available_permits(), 0);

        let (released, signal) = release.as_ref();
        *released.lock() = true;
        signal.notify_all();
        timeout(Duration::from_secs(1), async {
            while monitor.parity_read_permit.available_permits() != PARITY_READ_CONCURRENCY {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("released hung reads restore all permits");
    }

    #[tokio::test]
    async fn waiter_does_not_spawn_a_read_after_circuit_opens() {
        let mut database = MockParityDatabase::new();
        database.expect_retrieve_message_by_nonce().times(0);
        let monitor = Arc::new(monitor(Arc::new(database)));
        let permits = monitor
            .parity_read_permit
            .clone()
            .acquire_many_owned(PARITY_READ_CONCURRENCY as u32)
            .await
            .expect("reserve all read permits");
        let waiter = {
            let monitor = monitor.clone();
            tokio::spawn(async move {
                monitor
                    .observe_parity(
                        5,
                        EventKind::Dispatch,
                        ParityInput::Dispatch {
                            block_number: 100,
                            message: dispatch_message(7, b"payload"),
                            transaction_id: dispatch_transaction_id(),
                        },
                    )
                    .await
            })
        };
        sleep(Duration::from_millis(10)).await;
        monitor.disable_parity_reads("test", DISPATCH_EVENT_TYPE, "test circuit open");
        drop(permits);

        assert_eq!(
            timeout(Duration::from_secs(1), waiter)
                .await
                .expect("waiting parity job terminates")
                .expect("waiting parity task"),
            "error"
        );
        assert_eq!(
            monitor.parity_read_permit.available_permits(),
            PARITY_READ_CONCURRENCY
        );
    }

    #[tokio::test]
    async fn terminal_failure_is_durable_before_cursor_advancement() {
        let mut database = MockParityDatabase::new();
        database
            .expect_retrieve_message_by_nonce()
            .times(1)
            .returning(|nonce| Ok(Some(dispatch_message(nonce, b"conflict"))));
        database
            .expect_retrieve_dispatched_block_number_by_nonce()
            .times(1)
            .returning(|_| Ok(Some(100)));
        database
            .expect_retrieve_dispatched_tx_hash_by_message_id()
            .times(1)
            .returning(|_| Ok(Some(dispatch_transaction_id())));
        let monitor = Arc::new(monitor(Arc::new(database)));
        let input = StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &monitor.sources,
            )
            .expect("valid dispatch")
            .parity
            .expect("dispatch has parity input");
        monitor
            .enqueue_parity(5, EventKind::Dispatch, input, 7)
            .await;

        timeout(Duration::from_secs(1), async {
            while monitor.sources[&5]
                .cursor(EventKind::Dispatch)
                .expect("cursor read")
                != Some(7)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("terminal cursor persistence");
        let source = monitor.sources[&5].clone();
        assert!(source
            .parity_unhealthy(EventKind::Dispatch)
            .expect("health read"));
        assert_eq!(
            source
                .cursor_db
                .retrieve_value_by_key(PARITY_UNHEALTHY_PREFIX, &source.mailbox)
                .expect("read v2 parity poison"),
            Some(true)
        );

        let metrics = CoreMetrics::new("scraper-parity-restart", 9090, Registry::new())
            .expect("create restart metrics");
        let restarted = ScraperWebSocketMonitor::new(
            Url::parse("ws://localhost:1").expect("test URL"),
            vec![source],
            &metrics,
        )
        .expect("restart monitor");
        assert!(restarted
            .parity_unhealthy
            .lock()
            .contains(&(5, EventKind::Dispatch)));
        assert_eq!(
            restarted
                .parity_ready
                .with_label_values(&["test", DISPATCH_EVENT_TYPE])
                .get(),
            0
        );
    }

    #[test]
    fn retained_v1_parity_poison_does_not_poison_v2_epoch() {
        let fixture = fixture();
        let source = &fixture.sources[&5];
        source
            .cursor_db
            .store_value_by_key(PARITY_UNHEALTHY_V1_PREFIX, &source.mailbox, &true)
            .expect("store retained v1 parity poison");

        assert!(!source
            .parity_unhealthy(EventKind::Dispatch)
            .expect("read clean v2 parity epoch"));
        assert_eq!(
            source
                .cursor_db
                .retrieve_value_by_key(PARITY_UNHEALTHY_V1_PREFIX, &source.mailbox)
                .expect("read retained v1 parity poison"),
            Some(true)
        );
    }

    #[tokio::test]
    async fn bounds_parity_reads_across_origins() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let release = Arc::new((parking_lot::Mutex::new(false), parking_lot::Condvar::new()));
        let metrics = CoreMetrics::new("scraper-parity-global-bound", 9090, Registry::new())
            .expect("create test metrics");
        let mut sources = Vec::new();

        for domain in 1..=(PARITY_READ_CONCURRENCY + 1) as u32 {
            let mut database = MockParityDatabase::new();
            if domain <= PARITY_READ_CONCURRENCY as u32 {
                let entered_tx = entered_tx.clone();
                let release = release.clone();
                database
                    .expect_retrieve_message_by_nonce()
                    .times(1)
                    .returning(move |_| {
                        entered_tx.send(()).expect("record entered parity read");
                        let (released, signal) = release.as_ref();
                        let mut released = released.lock();
                        while !*released {
                            signal.wait(&mut released);
                        }
                        Err(hyperlane_base::db::DbError::Other(
                            "released test read".to_owned(),
                        ))
                    });
            } else {
                database
                    .expect_retrieve_message_by_nonce()
                    .times(1)
                    .returning(|_| {
                        Err(hyperlane_base::db::DbError::Other(
                            "queued test read".to_owned(),
                        ))
                    });
            }
            sources.push(ScraperSource::with_database(
                format!("test-{domain}"),
                domain,
                H256::from_low_u64_be(1),
                H256::from_low_u64_be(3),
                H256::from_low_u64_be(2),
                Arc::new(database),
            ));
        }
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new(
                Url::parse("ws://localhost:1").expect("test URL"),
                sources,
                &metrics,
            )
            .expect("create test monitor"),
        );
        let parity_input = |domain| ParityInput::Dispatch {
            block_number: 100,
            message: HyperlaneMessage {
                version: 3,
                nonce: domain,
                origin: domain,
                sender: H256::from_low_u64_be(3),
                destination: 6,
                recipient: H256::from_low_u64_be(4),
                body: b"payload".to_vec(),
            },
            transaction_id: dispatch_transaction_id(),
        };
        let mut parity_tasks = Vec::new();
        for domain in 1..=PARITY_READ_CONCURRENCY as u32 {
            let monitor = monitor.clone();
            let input = parity_input(domain);
            parity_tasks.push(tokio::spawn(async move {
                monitor
                    .observe_parity(domain, EventKind::Dispatch, input)
                    .await;
            }));
        }
        let entered = tokio::task::spawn_blocking(move || {
            (0..PARITY_READ_CONCURRENCY)
                .filter(|_| entered_rx.recv_timeout(Duration::from_secs(2)).is_ok())
                .count()
        })
        .await
        .expect("wait for blocking parity reads");

        let queued_domain = (PARITY_READ_CONCURRENCY + 1) as u32;
        let queued_chain = format!("test-{queued_domain}");
        let queued_monitor = monitor.clone();
        let queued_input = parity_input(queued_domain);
        let queued = tokio::spawn(async move {
            queued_monitor
                .observe_parity(queued_domain, EventKind::Dispatch, queued_input)
                .await;
        });
        tokio::task::yield_now().await;
        let skipped_count = monitor
            .parity
            .with_label_values(&[queued_chain.as_str(), DISPATCH_EVENT_TYPE, "skipped"])
            .get();
        let queued_pending = monitor
            .parity_pending
            .with_label_values(&[queued_chain.as_str(), DISPATCH_EVENT_TYPE])
            .get();

        let (released, signal) = release.as_ref();
        *released.lock() = true;
        signal.notify_all();
        for task in parity_tasks {
            task.await.expect("parity task must not panic");
        }
        queued.await.expect("queued parity task must not panic");
        timeout(Duration::from_secs(1), async {
            while monitor.parity_read_permit.available_permits() != PARITY_READ_CONCURRENCY {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("blocking reads release global permits");
        assert_eq!(entered, PARITY_READ_CONCURRENCY);
        assert_eq!(queued_pending, 1);
        assert_eq!(skipped_count, 0);
        assert_eq!(
            monitor.parity_read_permit.available_permits(),
            PARITY_READ_CONCURRENCY
        );
    }

    #[test]
    fn rate_limits_parity_warnings() {
        let warned_at = parking_lot::Mutex::new(None);
        assert!(should_warn(&warned_at));
        assert!(!should_warn(&warned_at));
    }

    #[test]
    fn merkle_parity_handles_lag_match_and_conflict() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let insertion = MerkleTreeInsertion::new(1, H256::from_low_u64_be(7));
        let data = merkle_data(1, H256::from_low_u64_be(2));

        let lagging = StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, data.clone()), &fixture.sources)
            .expect("lagging Merkle event");
        assert_eq!(
            lagging
                .parity
                .expect("Merkle parity")
                .compare(source.database.as_ref())
                .expect("lag comparison"),
            ParityResult::Missing
        );

        fixture
            .database
            .store_merkle_tree_insertion_by_leaf_index(&1, &insertion)
            .expect("store Merkle insertion");
        fixture
            .database
            .store_merkle_tree_insertion_block_number_by_leaf_index(&1, &101)
            .expect("store Merkle block");
        let matched = StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, data), &fixture.sources)
            .expect("matching Merkle event");
        assert_eq!(
            matched
                .parity
                .expect("Merkle parity")
                .compare(source.database.as_ref())
                .expect("match comparison"),
            ParityResult::Match
        );

        let mut conflict_data = merkle_data(1, H256::from_low_u64_be(2));
        conflict_data["block_number"] = serde_json::json!("102");
        let conflict = StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, conflict_data), &fixture.sources)
            .expect("conflicting Merkle event");
        assert_eq!(
            conflict
                .parity
                .expect("Merkle parity")
                .compare(source.database.as_ref())
                .expect("conflict comparison"),
            ParityResult::Conflict
        );
    }

    #[test]
    fn rejects_invalid_dispatch_payload() {
        let fixture = fixture();
        let mut missing_body = dispatch_data(7, b"original");
        missing_body["msg_body"] = serde_json::Value::Null;
        assert!(StreamState::default()
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, missing_body),
                &fixture.sources
            )
            .expect_err("missing body must reject")
            .to_string()
            .contains("omitted message body"));

        let mut bad_body = dispatch_data(7, b"original");
        bad_body["msg_body"] = serde_json::json!("\\x00");
        assert!(StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, bad_body), &fixture.sources)
            .expect_err("message ID mismatch must reject")
            .to_string()
            .contains("message ID"));

        let mut bad_sender = dispatch_data(7, b"original");
        bad_sender["sender"] = serde_json::json!("0x12");
        assert!(StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, bad_sender), &fixture.sources)
            .expect_err("invalid sender must reject")
            .to_string()
            .contains("address"));
    }

    #[test]
    fn rejects_wrong_dispatch_mailbox() {
        let fixture = fixture();
        let mut data = dispatch_data(7, b"payload");
        data["origin_mailbox"] = serde_json::json!(format!("{:#x}", H256::from_low_u64_be(3)));
        let error = StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, data), &fixture.sources)
            .expect_err("wrong mailbox must reject");

        assert!(error.to_string().contains("configured mailbox"));
    }

    #[test]
    fn rejects_wrong_merkle_hook() {
        let fixture = fixture();
        let mut state = StreamState::default();
        let error = state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    1,
                    merkle_data(1, H256::from_low_u64_be(3)),
                ),
                &fixture.sources,
            )
            .expect_err("wrong hook must reject");

        assert!(error.to_string().contains("configured hook"));
    }

    #[test]
    fn validates_merkle_payload_fields() {
        let fixture = fixture();
        let mut data = merkle_data(1, H256::from_low_u64_be(2));
        data["message_id"] = serde_json::json!("0x12");
        assert!(StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, data), &fixture.sources)
            .expect_err("invalid message ID must reject")
            .to_string()
            .contains("Merkle message ID"));
    }

    #[test]
    fn rejects_fields_outside_wire_projection() {
        let fixture = fixture();
        let mut dispatch = dispatch_data(7, b"payload");
        dispatch["time_updated"] = serde_json::json!("2026-08-30T00:00:01.000Z");
        assert!(StreamState::default()
            .validate(event(DISPATCH_EVENT_TYPE, 7, dispatch), &fixture.sources)
            .expect_err("unprojected dispatch field must reject")
            .to_string()
            .contains("Invalid dispatch event payload"));

        let mut merkle = merkle_data(1, H256::from_low_u64_be(2));
        merkle["id"] = serde_json::json!(42);
        assert!(StreamState::default()
            .validate(event(MERKLE_EVENT_TYPE, 1, merkle), &fixture.sources)
            .expect_err("unprojected Merkle field must reject")
            .to_string()
            .contains("Invalid Merkle tree insertion payload"));
    }

    #[test]
    fn validates_dense_gas_payment_cursors_and_duplicates() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let mut state = StreamState::default();
        assert!(state
            .validate_and_commit_gas_payment(gas_payment_event(10), &fixture.sources)
            .expect_err("gas payment before fresh baseline must reject")
            .to_string()
            .contains("before caught-up baseline"));
        assert!(!state.gas_payment_rows.contains_key(&5));
        assert_eq!(
            source.gas_payment_cursor().expect("read durable cursor"),
            None,
            "a pre-baseline event must not advance durable state"
        );
        state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("10"),
                None,
                &fixture.sources,
            )
            .expect("fresh gas payment baseline");
        assert_eq!(
            sequence(
                state
                    .validate_and_commit_gas_payment(gas_payment_event(10), &fixture.sources)
                    .expect("event at fresh gas payment baseline")
            ),
            (EventKind::GasPayment, SequenceResult::Duplicate)
        );
        let first_cursor = state.gas_payment_rows[&5];
        source
            .store_gas_payment_cursor(&first_cursor)
            .expect("persist first gas payment");
        assert_eq!(
            sequence(
                state
                    .validate_and_commit_gas_payment(gas_payment_event(11), &fixture.sources)
                    .expect("next gas payment")
            ),
            (EventKind::GasPayment, SequenceResult::Accepted)
        );
        let cursor = state.gas_payment_rows[&5];
        source
            .store_gas_payment_cursor(&cursor)
            .expect("persist next gas payment");
        assert_eq!(
            sequence(
                state
                    .validate_and_commit_gas_payment(gas_payment_event(11), &fixture.sources)
                    .expect("duplicate gas payment")
            ),
            (EventKind::GasPayment, SequenceResult::Duplicate)
        );
        assert!(state
            .validate_and_commit_gas_payment(gas_payment_event(10), &fixture.sources)
            .expect_err("row ID regression must reject")
            .to_string()
            .contains("backwards"));

        let gap = state
            .validate_and_commit_gas_payment(gas_payment_event(13), &fixture.sources)
            .expect_err("logical cursor gap must reject");
        assert!(gap.downcast_ref::<StreamGap>().is_some());
        assert_eq!(
            gap.to_string(),
            "Scraper stream gap: expected sequence 12, received 13"
        );
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 11);
        assert_eq!(
            source.gas_payment_cursor().expect("read durable cursor"),
            Some(cursor),
            "a rejected cursor gap must not advance durable state"
        );
    }

    #[test]
    fn accepts_sparse_legacy_then_requires_dense_gas_cursors() {
        let sources = sources();
        let mut state = StreamState::default();
        state.gas_payment_rows.insert(
            5,
            DurableGasPaymentCursor {
                fingerprint: None,
                legacy_max_stream_cursor: 20,
                stream_cursor: 10,
            },
        );

        assert_eq!(
            state
                .validate_and_commit_gas_payment(gas_payment_event_with_boundary(20, 20), &sources)
                .expect("sparse legacy cursor")
                .sequence_result,
            SequenceResult::Accepted
        );
        assert_eq!(
            state
                .validate_and_commit_gas_payment(gas_payment_event_with_boundary(21, 20), &sources)
                .expect("first mapped cursor")
                .sequence_result,
            SequenceResult::Accepted
        );
        assert!(state
            .validate_and_commit_gas_payment(gas_payment_event_with_boundary(23, 20), &sources)
            .expect_err("mapped cursor gap")
            .downcast_ref::<StreamGap>()
            .is_some());
        assert!(state
            .validate_and_commit_gas_payment(gas_payment_event_with_boundary(22, 21), &sources)
            .expect_err("changed legacy boundary")
            .to_string()
            .contains("boundary changed"));

        let mut missing_boundary = gas_payment_event_with_boundary(22, 20);
        missing_boundary.legacy_max_stream_cursor = None;
        assert!(state
            .validate(missing_boundary, &sources)
            .expect_err("event boundary is required")
            .to_string()
            .contains("omitted legacy cursor boundary"));
        assert!(state
            .gas_payment_caught_up_cursor(
                &scraper_address(H256::from_low_u64_be(3)),
                sources.get(&5).expect("test source"),
                None,
                None,
                Some("21"),
                None,
            )
            .expect_err("caught-up boundary is required")
            .to_string()
            .contains("omitted legacy cursor boundary"));
        assert!(state
            .gas_payment_caught_up_cursor(
                &scraper_address(H256::from_low_u64_be(3)),
                sources.get(&5).expect("test source"),
                Some("21"),
                None,
                Some("21"),
                None,
            )
            .expect_err("caught-up boundary must match events")
            .to_string()
            .contains("boundary changed"));
    }

    #[test]
    fn failed_fresh_gas_baseline_store_does_not_advance_resume() {
        let monitor = monitor(Arc::new(MockParityDatabase::new()));
        let mut state = StreamState::default();
        let cursor = state
            .gas_payment_caught_up_cursor(
                &scraper_address(H256::from_low_u64_be(3)),
                monitor.sources.get(&5).expect("test source"),
                Some("20"),
                None,
                Some("20"),
                None,
            )
            .expect("valid fresh gas baseline");

        assert!(state
            .persist_gas_payment_cursor(5, cursor, |_| bail!("store failed"))
            .expect_err("durable store failure")
            .to_string()
            .contains("store failed"));
        assert!(!state.gas_payment_rows.contains_key(&5));
        assert_eq!(
            monitor.gas_payment_cursors(&state)[0].after_stream_cursor,
            None
        );
    }

    #[test]
    fn failed_gas_event_store_keeps_prior_resume_and_fingerprint() {
        let monitor = monitor(Arc::new(MockParityDatabase::new()));
        let prior = DurableGasPaymentCursor {
            fingerprint: None,
            legacy_max_stream_cursor: 20,
            stream_cursor: 10,
        };
        let mut state = StreamState::default();
        state.gas_payment_rows.insert(5, prior);

        let accepted = state
            .validate(gas_payment_event_with_boundary(20, 20), &monitor.sources)
            .expect("valid sparse legacy event");
        assert!(state
            .persist_gas_payment_cursor(
                5,
                accepted.gas_payment.expect("accepted event input").cursor,
                |_| bail!("store failed"),
            )
            .is_err());
        assert_eq!(state.gas_payment_rows[&5], prior);
        assert_eq!(
            monitor.gas_payment_cursors(&state)[0].after_stream_cursor,
            Some("10".to_owned())
        );

        let duplicate = state
            .validate(gas_payment_event_with_boundary(10, 20), &monitor.sources)
            .expect("valid duplicate event");
        let duplicate_cursor = duplicate.gas_payment.expect("duplicate event input").cursor;
        assert!(duplicate_cursor.fingerprint.is_some());
        assert!(state
            .persist_gas_payment_cursor(5, duplicate_cursor, |_| bail!("store failed"),)
            .is_err());
        assert_eq!(state.gas_payment_rows[&5], prior);
        assert_eq!(state.gas_payment_rows[&5].fingerprint, None);
    }

    #[test]
    fn accepts_logical_gas_cursor_distinct_from_physical_row_id() {
        let sources = sources();
        let mut event = gas_payment_event(20);
        event.row_id = Some("200".to_owned());
        event.data["id"] = serde_json::json!("200");
        let mut state = StreamState::default();
        state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("19"),
                None,
                &sources,
            )
            .expect("gas payment baseline");
        assert_eq!(
            state
                .validate_and_commit_gas_payment(event, &sources)
                .expect("logical cursor may differ from physical row ID")
                .sequence_result,
            SequenceResult::Accepted
        );
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 20);

        let mut mismatch = gas_payment_event(21);
        mismatch.data["id"] = serde_json::json!("201");
        assert!(state
            .validate(mismatch, &sources)
            .expect_err("physical row ID mismatch must reject")
            .to_string()
            .contains("row ID does not match"));
    }

    #[test]
    fn unresolved_gas_metadata_preserves_rpc_indexing_in_both_arrival_orders() {
        for rpc_first in [false, true] {
            let fixture = fixture();
            let source = &fixture.sources[&5];
            let payment = Indexed::new(InterchainGasPayment {
                message_id: H256::from_low_u64_be(7),
                destination: 6,
                payment: U256::from(1000),
                gas_amount: U256::from(50000),
            })
            .with_sequence(0);
            // Sealevel basic metadata retains the payment account's real slot
            // even when transaction and block hashes could not be resolved.
            let rpc_meta = LogMeta {
                address: source.interchain_gas_paymaster,
                block_number: 123_456,
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                transaction_index: 0,
                log_index: U256::zero(),
            };
            if rpc_first {
                assert!(fixture
                    .database
                    .process_indexed_gas_payment(payment, &rpc_meta)
                    .expect("RPC indexes the canonical slot first"));
            }
            let mut event = gas_payment_event(10);
            for field in [
                "tx_id",
                "origin_tx_hash",
                "origin_block_hash",
                "origin_block_height",
            ] {
                event.data[field] = serde_json::Value::Null;
            }
            event.data["sequence"] = serde_json::json!("0");
            let mut state = StreamState::default();
            state
                .accept_gas_payment_caught_up(
                    &scraper_address(source.interchain_gas_paymaster),
                    5,
                    None,
                    Some("9"),
                    None,
                    &fixture.sources,
                )
                .expect("gas payment baseline");
            assert!(state
                .validate(event, &fixture.sources)
                .expect_err("unknown block height must not become authoritative metadata")
                .to_string()
                .contains("canonical block height"));
            assert_eq!(state.gas_payment_rows[&5].stream_cursor, 9);
            assert_eq!(
                fixture
                    .database
                    .retrieve_gas_payment_block_by_sequence(&0)
                    .expect("read untouched block metadata"),
                rpc_first.then_some(rpc_meta.block_number),
            );
            assert_eq!(
                fixture
                    .database
                    .process_indexed_gas_payment(payment, &rpc_meta)
                    .expect("RPC indexing remains live after the shadow event"),
                !rpc_first
            );
            assert_eq!(
                fixture
                    .database
                    .retrieve_gas_payment_block_by_sequence(&0)
                    .expect("read canonical slot"),
                Some(rpc_meta.block_number),
            );
            let total = fixture
                .database
                .retrieve_gas_payment_by_gas_payment_key((*payment.inner()).into())
                .expect("read aggregate")
                .expect("aggregate exists");
            assert_eq!(total.payment, U256::from(1000));
            assert_eq!(total.gas_amount, U256::from(50000));
        }
    }

    #[test]
    fn resolved_gas_metadata_dedupes_rpc_in_both_arrival_orders() {
        for rpc_first in [false, true] {
            let fixture = fixture();
            let source = &fixture.sources[&5];
            let mut state = StreamState::default();
            state
                .accept_gas_payment_caught_up(
                    &scraper_address(source.interchain_gas_paymaster),
                    5,
                    None,
                    Some("9"),
                    None,
                    &fixture.sources,
                )
                .expect("gas payment baseline");
            let mut event = gas_payment_event(10);
            event.data["sequence"] = serde_json::json!("0");
            let input = state
                .validate(event, &fixture.sources)
                .expect("resolved metadata remains supported")
                .gas_payment
                .expect("gas payment input");
            let rpc_meta = LogMeta {
                block_hash: H256::zero(),
                transaction_id: H512::zero(),
                ..input.meta.clone()
            };
            assert_eq!(rpc_meta.block_number, 100);
            if rpc_first {
                assert!(fixture
                    .database
                    .process_indexed_gas_payment(input.payment, &rpc_meta)
                    .expect("RPC indexes first"));
            }
            source
                .store_gas_payment(&input)
                .expect("store resolved shadow payment");
            assert!(!fixture
                .database
                .process_indexed_gas_payment(input.payment, &rpc_meta)
                .expect("RPC deduplicates the same payment and canonical slot"));
            let total = fixture
                .database
                .retrieve_gas_payment_by_gas_payment_key((*input.payment.inner()).into())
                .expect("read aggregate")
                .expect("aggregate exists");
            assert_eq!(total.payment, U256::from(1000));
            assert_eq!(total.gas_amount, U256::from(50000));
            assert_eq!(
                fixture
                    .database
                    .retrieve_gas_payment_block_by_sequence(&0)
                    .expect("read canonical block"),
                Some(100)
            );
        }
    }

    #[test]
    fn rejects_invalid_gas_payment_projection() {
        let mut wrong_paymaster = gas_payment_event(10);
        wrong_paymaster.data["interchain_gas_paymaster"] =
            serde_json::json!(format!("{:#x}", H256::from_low_u64_be(4)));
        assert!(StreamState::default()
            .validate(wrong_paymaster, &sources())
            .expect_err("wrong paymaster must reject")
            .to_string()
            .contains("configured paymaster"));

        let mut unresolved = gas_payment_event(10);
        unresolved.data["tx_id"] = serde_json::Value::Null;
        assert!(StreamState::default()
            .validate(unresolved, &sources())
            .expect_err("partial transaction metadata must reject")
            .to_string()
            .contains("only partially resolved"));

        let mut mismatched_fallback = gas_payment_event(10);
        mismatched_fallback.data["tx_id"] = serde_json::Value::Null;
        mismatched_fallback.data["origin_tx_hash"] = serde_json::Value::Null;
        mismatched_fallback.data["origin_block_hash"] = serde_json::Value::Null;
        mismatched_fallback.data["origin_block_height"] = serde_json::Value::Null;
        mismatched_fallback.data["sequence"] = serde_json::json!("1");
        assert!(StreamState::default()
            .validate(mismatched_fallback, &sources())
            .expect_err("fallback identity mismatch must reject")
            .to_string()
            .contains("log index does not match"));
    }

    #[test]
    fn rejects_cursor_kind_mismatch() {
        let mut sequenced_with_row_id = event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, b"body"));
        sequenced_with_row_id.row_id = Some("10".to_owned());
        assert!(StreamState::default()
            .validate(sequenced_with_row_id, &sources())
            .expect_err("sequenced event with row cursor must reject")
            .to_string()
            .contains("unexpectedly included a row/stream cursor"));

        let mut row_with_sequence = gas_payment_event(10);
        row_with_sequence.sequence = Some("0".to_owned());
        assert!(StreamState::default()
            .validate(row_with_sequence, &sources())
            .expect_err("row event with sequence cursor must reject")
            .to_string()
            .contains("unexpectedly included stream sequence"));
    }

    #[test]
    fn advances_gas_payment_cursor_from_caught_up_marker() {
        let sources = sources();
        let mut state = StreamState::default();
        state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("20"),
                None,
                &sources,
            )
            .expect("caught-up marker");
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 20);
        assert_eq!(
            sequence(
                state
                    .validate_and_commit_gas_payment(gas_payment_event(21), &sources)
                    .expect("next live row")
            ),
            (EventKind::GasPayment, SequenceResult::Accepted)
        );
        state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("21"),
                None,
                &sources,
            )
            .expect("caught-up marker must equal the validated cursor");
        assert!(state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("19"),
                None,
                &sources,
            )
            .is_err());
        assert!(state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("22"),
                None,
                &sources,
            )
            .expect_err("caught-up marker must not omit an unvalidated cursor")
            .to_string()
            .contains("does not equal validated cursor"));
    }

    #[test]
    fn promotes_and_persists_first_event_at_caught_up_baseline() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let mut state = StreamState::default();
        state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("20"),
                None,
                &fixture.sources,
            )
            .expect("first-subscription baseline");
        assert_eq!(state.gas_payment_rows[&5].fingerprint, None);
        assert_eq!(
            state
                .validate_and_commit_gas_payment(gas_payment_event(20), &fixture.sources)
                .expect("event at baseline")
                .sequence_result,
            SequenceResult::Duplicate
        );
        let cursor = state.gas_payment_rows[&5];
        assert!(cursor.fingerprint.is_some());
        source
            .store_gas_payment_cursor(&cursor)
            .expect("persist promoted boundary fingerprint");

        let mut restarted =
            StreamState::load_gas_payment(&fixture.sources).expect("restart cursor load");
        let mut conflict = gas_payment_event(20);
        conflict.data["payment"] = serde_json::json!("2");
        assert!(restarted
            .validate(conflict, &fixture.sources)
            .expect_err("conflicting event at promoted boundary must reject after restart")
            .to_string()
            .contains("Conflicting gas payment event"));
    }

    #[test]
    fn validates_dispatch_and_merkle_projections_independently() {
        let fixture = fixture();
        let mut state = StreamState::default();
        let message = dispatch_message(7, b"payload");
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &fixture.sources,
            )
            .expect("dispatch should validate");
        state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), message.id(), 100),
                ),
                &fixture.sources,
            )
            .expect("Merkle insertion should validate");
    }

    #[test]
    fn accepts_different_message_ids_at_the_same_stream_sequence() {
        let fixture = fixture();
        let first = dispatch_message(7, b"first");
        let second = dispatch_message(8, b"second");
        let mut state = StreamState::default();
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"first")),
                &fixture.sources,
            )
            .expect("dispatch should validate");
        state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), second.id(), 100),
                ),
                &fixture.sources,
            )
            .expect("same numeric sequence may identify another message");
        state
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    8,
                    merkle_data_for(8, H256::from_low_u64_be(2), first.id(), 100),
                ),
                &fixture.sources,
            )
            .expect("first message may appear at another Merkle sequence");
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 8, dispatch_data(8, b"second")),
                &fixture.sources,
            )
            .expect("second message may appear at another dispatch sequence");
    }

    #[test]
    fn accepts_normalized_replay_cursor_confirmation() {
        let sources = sources();
        let source = sources.get(&5).expect("source");
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            source.store_cursor(kind, 42).expect("store durable cursor");
        }
        let plan = replay_plan(&sources);
        let streams = subscribed_streams(&sources, &plan);
        for stream in &streams[..2] {
            let cursor = stream.cursors.as_ref().expect("sequenced cursor");
            assert_eq!(cursor[0].after_sequence.as_deref(), Some("41"));
            assert_eq!(cursor[0].address.len(), 42);
        }

        validate_subscription(&streams, &sources, &plan, &gas_payment_cursors(), true)
            .expect("normalized replay cursor confirmation");
    }

    #[test]
    fn rejects_subscription_confirmation_mismatch() {
        let sources = sources();
        let cursors = gas_payment_cursors();
        let plan = replay_plan(&sources);
        let foreign_sources = sources_for(&[9]);
        let foreign_plan = replay_plan(&foreign_sources);
        for streams in [
            subscribed_streams(&foreign_sources, &foreign_plan),
            vec![SubscribedStream {
                cursors: None,
                domains: Some(vec![5]),
                event_type: DISPATCH_EVENT_TYPE.to_owned(),
                stream_cursor_version: None,
            }],
            subscribed_streams(&sources, &plan)
                .into_iter()
                .rev()
                .collect(),
        ] {
            assert!(validate_subscription(&streams, &sources, &plan, &cursors, true).is_err());
        }
    }

    #[test]
    fn multiplexes_live_streams_on_one_subscription() {
        let sources = sources_for(&[9, 5]);
        let plan = replay_plan(&sources);
        let gas_payment_cursors = vec![
            SubscribedCursor {
                address: "0x0000000000000000000000000000000000000003".to_owned(),
                after_stream_cursor: None,
                after_sequence: None,
                domain: 5,
            },
            SubscribedCursor {
                address: "0x0000000000000000000000000000000000000004".to_owned(),
                after_stream_cursor: Some("41".to_owned()),
                after_sequence: None,
                domain: 9,
            },
        ];
        let message: serde_json::Value = serde_json::to_value(
            &subscription(&sources, &plan, &gas_payment_cursors, true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");

        assert_eq!(
            message,
            serde_json::json!({
                "streams": [
                    {
                        "cursors": [
                            { "address": scraper_address(H256::from_low_u64_be(1)), "allowReplay": true, "domain": 5 },
                            { "address": scraper_address(H256::from_low_u64_be(1)), "allowReplay": true, "domain": 9 }
                        ],
                        "domains": [5, 9],
                        "eventType": "dispatch"
                    },
                    {
                        "cursors": [
                            { "address": scraper_address(H256::from_low_u64_be(2)), "allowReplay": true, "domain": 5 },
                            { "address": scraper_address(H256::from_low_u64_be(2)), "allowReplay": true, "domain": 9 }
                        ],
                        "domains": [5, 9],
                        "eventType": "merkle_tree_insertion"
                    },
                    {
                        "cursors": [
                            { "address": "0x0000000000000000000000000000000000000003", "domain": 5 },
                            { "address": "0x0000000000000000000000000000000000000004", "afterStreamCursor": "41", "domain": 9 }
                        ],
                        "domains": [5, 9],
                        "eventType": "gas_payment",
                        "streamCursorVersion": 3
                    }
                ],
                "type": "subscribe"
            })
        );
    }

    #[test]
    fn restores_durable_gas_payment_cursor_after_restart() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let mut state =
            StreamState::load_gas_payment(&fixture.sources).expect("initial cursor load");
        state
            .accept_gas_payment_caught_up(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                None,
                Some("19"),
                None,
                &fixture.sources,
            )
            .expect("gas payment baseline");
        let validated = state
            .validate_and_commit_gas_payment(gas_payment_event(20), &fixture.sources)
            .expect("valid gas payment");
        assert_eq!(validated.kind, EventKind::GasPayment);
        let cursor = state.gas_payment_rows[&5];
        source
            .store_gas_payment_cursor(&cursor)
            .expect("persist gas payment cursor");

        let mut restarted =
            StreamState::load_gas_payment(&fixture.sources).expect("restart cursor load");
        assert_eq!(restarted.gas_payment_rows[&5].stream_cursor, 20);
        assert_eq!(
            source.gas_payment_cursor().expect("read cursor"),
            Some(cursor)
        );
        assert_eq!(
            restarted
                .validate_and_commit_gas_payment(gas_payment_event(20), &fixture.sources)
                .expect("replayed durable cursor")
                .sequence_result,
            SequenceResult::Duplicate
        );
        let mut conflict = gas_payment_event(20);
        conflict.data["payment"] = serde_json::json!("2");
        assert!(restarted
            .validate(conflict, &fixture.sources)
            .expect_err("persisted boundary fingerprint must reject a restart conflict")
            .to_string()
            .contains("Conflicting gas payment event"));
    }

    #[test]
    fn migrates_v2_gas_cursor_without_reusing_payload_fingerprint_or_poison() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let legacy = DurableGasPaymentCursor {
            fingerprint: Some(H256::from_low_u64_be(9)),
            legacy_max_stream_cursor: 20,
            stream_cursor: 10,
        };
        source
            .store_gas_payment_v2_cursor(&legacy)
            .expect("store v2 gas cursor");
        source
            .cursor_db
            .store_value_by_key(
                b"scraper_websocket_gas_payment_degraded_v2",
                &source.interchain_gas_paymaster,
                &true,
            )
            .expect("store v2 degradation marker");

        let mut state =
            StreamState::load_gas_payment(&fixture.sources).expect("load v2 gas cursor");
        assert_eq!(state.gas_payment_v2_rows.get(&5), Some(&legacy));
        assert_eq!(state.gas_payment_resume_cursor(5), Some(10));
        assert!(!state.gas_payment_degraded.contains(&5));
        let validated = state
            .validate(gas_payment_event_with_boundary(10, 20), &fixture.sources)
            .expect("v3 duplicate replaces the v2 payload fingerprint");
        assert_eq!(validated.sequence_result, SequenceResult::Duplicate);
        state
            .persist_gas_payment_cursor(
                5,
                validated.gas_payment.expect("migrated v3 gas input").cursor,
                |cursor| source.store_gas_payment_cursor(cursor),
            )
            .expect("persist v3 gas cursor");
        assert!(!state.gas_payment_v2_rows.contains_key(&5));
        assert_ne!(state.gas_payment_rows[&5].fingerprint, legacy.fingerprint);

        let restarted =
            StreamState::load_gas_payment(&fixture.sources).expect("reload migrated gas cursor");
        assert!(!restarted.gas_payment_v2_rows.contains_key(&5));
        assert_eq!(restarted.gas_payment_rows[&5], state.gas_payment_rows[&5]);
        assert!(!restarted.gas_payment_degraded.contains(&5));
    }

    #[test]
    fn migrates_sparse_v1_gas_cursor_without_replaying_from_tip() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        let legacy = LegacyDurableGasPaymentCursor {
            fingerprint: Some(H256::from_low_u64_be(9)),
            stream_cursor: 10,
        };
        source
            .store_gas_payment_v1_cursor(&legacy)
            .expect("store v1 gas cursor");
        source
            .cursor_db
            .store_value_by_key(
                b"scraper_websocket_gas_payment_degraded_v1",
                &source.interchain_gas_paymaster,
                &true,
            )
            .expect("store v1 degradation marker");

        let mut state =
            StreamState::load_gas_payment(&fixture.sources).expect("load v1 gas cursor");
        assert_eq!(state.gas_payment_v1_rows.get(&5), Some(&legacy));
        assert_eq!(state.gas_payment_resume_cursor(5), Some(10));
        assert!(!state.gas_payment_degraded.contains(&5));
        let validated = state
            .validate(gas_payment_event_with_boundary(20, 20), &fixture.sources)
            .expect("sparse v1 replay");
        assert_eq!(validated.sequence_result, SequenceResult::Accepted);
        state
            .persist_gas_payment_cursor(
                5,
                validated.gas_payment.expect("migrated v3 gas input").cursor,
                |cursor| source.store_gas_payment_cursor(cursor),
            )
            .expect("persist v3 gas cursor");
        assert!(!state.gas_payment_v1_rows.contains_key(&5));
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 20);
        assert_eq!(state.gas_payment_rows[&5].legacy_max_stream_cursor, 20);

        let restarted =
            StreamState::load_gas_payment(&fixture.sources).expect("reload migrated gas cursor");
        assert!(!restarted.gas_payment_v1_rows.contains_key(&5));
        assert_eq!(restarted.gas_payment_rows[&5], state.gas_payment_rows[&5]);
        assert!(!restarted.gas_payment_degraded.contains(&5));
    }

    #[test]
    fn migrates_dense_v1_gas_cursor_contiguously() {
        let fixture = fixture();
        let source = fixture.sources.get(&5).expect("source");
        source
            .store_gas_payment_v1_cursor(&LegacyDurableGasPaymentCursor {
                fingerprint: None,
                stream_cursor: 20,
            })
            .expect("store dense v1 gas cursor");
        let mut state =
            StreamState::load_gas_payment(&fixture.sources).expect("load dense v1 gas cursor");

        assert!(state
            .validate(gas_payment_event_with_boundary(22, 20), &fixture.sources,)
            .expect_err("dense v1 migration gap")
            .downcast_ref::<StreamGap>()
            .is_some());
        let validated = state
            .validate(gas_payment_event_with_boundary(21, 20), &fixture.sources)
            .expect("contiguous dense v1 migration");
        assert_eq!(validated.sequence_result, SequenceResult::Accepted);
        state
            .persist_gas_payment_cursor(
                5,
                validated
                    .gas_payment
                    .expect("migrated dense v3 gas input")
                    .cursor,
                |cursor| source.store_gas_payment_cursor(cursor),
            )
            .expect("persist dense v3 gas cursor");
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 21);
    }

    #[test]
    fn legacy_subscription_preserves_sequenced_streams() {
        let sources = sources();
        let plan = replay_plan(&sources);
        let message: serde_json::Value = serde_json::to_value(
            &subscription(&sources, &plan, &gas_payment_cursors(), false)
                .expect("legacy subscription serialization"),
        )
        .expect("legacy subscription JSON");
        let streams = message["streams"].as_array().expect("subscription streams");
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0]["eventType"], DISPATCH_EVENT_TYPE);
        assert_eq!(streams[1]["eventType"], MERKLE_EVENT_TYPE);
        assert!(is_unsupported_row_cursor_error(
            "cursors are only supported for sequenced streams"
        ));
        assert!(!is_unsupported_row_cursor_error(
            "temporary upstream failure"
        ));
    }

    #[tokio::test]
    async fn v2_ready_rejects_unsolicited_gas_messages() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("test server address")
        ))
        .expect("test server URL");
        let metrics =
            CoreMetrics::new("legacy-gas-cross-talk", 0, Registry::new()).expect("test metrics");
        let monitor = Arc::new(
            ScraperWebSocketMonitor::new(url, sources().into_values().collect(), &metrics)
                .expect("test monitor"),
        );
        let (finish_tx, finish_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept test client");
            let mut socket = accept_async(stream).await.expect("accept websocket");
            socket
                .send(Message::Text(
                    r#"{"streamCursorVersions":{"gas_payment":2},"type":"ready"}"#.to_owned(),
                ))
                .await
                .expect("send v1 ready");
            let request = socket
                .next()
                .await
                .expect("subscription message")
                .expect("read subscription");
            let request: serde_json::Value =
                serde_json::from_str(request.to_text().expect("text subscription"))
                    .expect("subscription JSON");
            assert_eq!(
                request["streams"]
                    .as_array()
                    .expect("subscription streams")
                    .len(),
                2
            );
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "streams": proxy_subscription_response(&request),
                        "type": "subscribed",
                    })
                    .to_string(),
                ))
                .await
                .expect("send subscribed");
            socket
                .send(Message::Text(wire_event(gas_payment_event(1)).to_string()))
                .await
                .expect("send unsolicited gas event");
            finish_rx.await.expect("finish server");
        });

        let mut state = StreamState::default();
        let err = monitor
            .stream_once(&mut state)
            .await
            .expect_err("legacy subscription must reject unsolicited gas cross-talk");
        assert!(format!("{err:?}").contains("without negotiated cursor support"));
        finish_tx.send(()).expect("finish server");
        server.await.expect("join server");
    }

    #[tokio::test]
    async fn quarantines_unresolved_gas_payment_without_stopping_other_streams() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let url = Url::parse(&format!(
            "ws://{}",
            listener.local_addr().expect("test server address")
        ))
        .expect("test server URL");
        let metrics = CoreMetrics::new("test", 0, Registry::new()).expect("test metrics");
        let monitor = std::sync::Arc::new(
            ScraperWebSocketMonitor::new(url, sources().into_values().collect(), &metrics)
                .expect("test monitor"),
        );
        let (subscribed_tx, subscribed_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let (sent_tx, sent_rx) = oneshot::channel();
        let (finish_tx, finish_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept test client");
            let mut socket = accept_async(stream).await.expect("accept websocket");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "streamCursorVersions": { "gas_payment": GAS_PAYMENT_STREAM_CURSOR_VERSION },
                        "type": "ready"
                    })
                    .to_string(),
                ))
                .await
                .expect("send ready");
            let request = socket
                .next()
                .await
                .expect("subscription message")
                .expect("read subscription");
            let request: serde_json::Value =
                serde_json::from_str(request.to_text().expect("text subscription"))
                    .expect("subscription JSON");
            socket
                .send(Message::Text(
                    serde_json::json!({
                        "streams": proxy_subscription_response(&request),
                        "type": "subscribed",
                    })
                    .to_string(),
                ))
                .await
                .expect("send subscribed");
            subscribed_tx.send(()).expect("signal subscribed");
            release_rx.await.expect("release test server");

            let mut poison = gas_payment_event(10);
            for field in [
                "tx_id",
                "origin_tx_hash",
                "origin_block_hash",
                "origin_block_height",
            ] {
                poison.data[field] = serde_json::Value::Null;
            }
            poison.data["sequence"] = serde_json::json!("0");
            let message = dispatch_message(7, b"payload");
            let messages = [
                serde_json::json!({
                    "address": scraper_address(H256::from_low_u64_be(3)),
                    "domain": 5,
                    "eventType": GAS_PAYMENT_EVENT_TYPE,
                    "legacyMaxStreamCursor": "0",
                    "streamCursor": "9",
                    "type": "caught_up",
                }),
                wire_event(poison),
                wire_event(event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload"))),
                wire_event(event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), message.id(), 100),
                )),
                wire_event(gas_payment_event(11)),
                serde_json::json!({
                    "address": scraper_address(H256::from_low_u64_be(3)),
                    "domain": 5,
                    "eventType": GAS_PAYMENT_EVENT_TYPE,
                    "streamCursor": "11",
                    "type": "caught_up",
                }),
            ];
            for message in messages {
                socket
                    .send(Message::Text(message.to_string()))
                    .await
                    .expect("send test message");
            }
            sent_tx.send(()).expect("signal messages sent");
            finish_rx.await.expect("finish test stream");
            let mut unexpected_domain = gas_payment_event(12);
            unexpected_domain.domain = 6;
            socket
                .send(Message::Text(wire_event(unexpected_domain).to_string()))
                .await
                .expect("send unexpected-domain event");
        });

        let stream_monitor = monitor.clone();
        let stream = tokio::spawn(async move {
            let mut state = StreamState::default();
            let result = stream_monitor.stream_once(&mut state).await;
            (result, state)
        });
        subscribed_rx.await.expect("subscription confirmation");
        timeout(Duration::from_secs(5), async {
            while monitor.active.with_label_values(&["test-5"]).get() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("monitor should become active");
        assert_eq!(
            monitor
                .caught_up
                .with_label_values(&["test-5", GAS_PAYMENT_EVENT_TYPE])
                .get(),
            0
        );

        release_tx.send(()).expect("release test messages");
        sent_rx.await.expect("test messages sent");
        timeout(Duration::from_secs(5), async {
            while monitor
                .degraded
                .with_label_values(&["test-5", GAS_PAYMENT_EVENT_TYPE])
                .get()
                != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("gas payment stream should report degradation");
        assert_eq!(
            monitor
                .caught_up
                .with_label_values(&["test-5", GAS_PAYMENT_EVENT_TYPE])
                .get(),
            0
        );
        finish_tx.send(()).expect("finish test stream");
        let (result, state) = stream.await.expect("join monitor stream");
        server.await.expect("join test server");

        let error = format!(
            "{:?}",
            result.expect_err("unexpected domain should fail the stream")
        );
        assert!(
            error.contains("Unexpected scraper event domain 6"),
            "{error}"
        );
        assert_eq!(state.gas_payment_degraded, HashSet::from([5]));
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 9);
        let source = monitor.sources.get(&5).expect("source");
        assert_eq!(
            source
                .cursor_db
                .retrieve_gas_payment_by_sequence(&0)
                .expect("unresolved payment must not enter the authoritative index"),
            None
        );
        assert!(source
            .gas_payment_degraded()
            .expect("read durable degradation"));
        let restarted_state =
            StreamState::load_gas_payment(&monitor.sources).expect("restart state");
        assert_eq!(restarted_state.gas_payment_degraded, HashSet::from([5]));
        let restart_metrics =
            CoreMetrics::new("scraper-gas-payment-restart", 9090, Registry::new())
                .expect("restart metrics");
        let restarted_monitor = ScraperWebSocketMonitor::new(
            Url::parse("ws://localhost:1").expect("test URL"),
            vec![source.clone()],
            &restart_metrics,
        )
        .expect("restart monitor");
        assert_eq!(
            restarted_monitor
                .degraded
                .with_label_values(&["test-5", GAS_PAYMENT_EVENT_TYPE])
                .get(),
            1
        );
        assert_eq!(
            restarted_monitor
                .caught_up
                .with_label_values(&["test-5", GAS_PAYMENT_EVENT_TYPE])
                .get(),
            0
        );
        assert_eq!(state.cursors[&(5, EventKind::Dispatch)].next_sequence, 8);
        assert_eq!(
            state.cursors[&(5, EventKind::MerkleTreeInsertion)].next_sequence,
            8
        );
        assert_eq!(
            monitor
                .events
                .with_label_values(&["test-5", GAS_PAYMENT_EVENT_TYPE, "invalid"])
                .get(),
            1
        );
        assert_eq!(
            monitor
                .caught_up
                .with_label_values(&["test", GAS_PAYMENT_EVENT_TYPE])
                .get(),
            0
        );
    }
}
