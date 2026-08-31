//! Shadow validation of relayer inputs streamed by scraper-proxy.

use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use eyre::{bail, Context, ContextCompat, Result};
use futures_util::{SinkExt, StreamExt};
use hyperlane_base::{
    db::{DbResult, HyperlaneDb, HyperlaneRocksDB},
    scraper_websocket::{
        EventMessage, GasPaymentCursor as GasPaymentSubscriptionCursor, SequenceCursor,
        ServerMessage, StreamCursor as SubscriptionCursor, StringOrNumber, SubscribeMessage,
        SubscribeStream, SubscribedCursor, SubscribedStream,
    },
    CoreMetrics,
};
use hyperlane_core::{
    bytes_to_address, bytes_to_h512, Decode, Encode, HyperlaneMessage, HyperlaneProtocolError,
    MerkleTreeInsertion, H256, H512, U256,
};
use prometheus::{IntCounterVec, IntGaugeVec};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{sleep, timeout, Instant},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use url::Url;

const DISPATCH_EVENT_TYPE: &str = "dispatch";
const GAS_PAYMENT_EVENT_TYPE: &str = "gas_payment";
const GAS_PAYMENT_STREAM_CURSOR_VERSION: u32 = 1;
const MERKLE_EVENT_TYPE: &str = "merkle_tree_insertion";
const READ_TIMEOUT: Duration = Duration::from_secs(75);
const RETRY_DELAY: Duration = Duration::from_secs(5);
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
const PARITY_RETRY_ATTEMPTS: usize = 60;
const PARITY_WARN_INTERVAL: Duration = Duration::from_secs(60);
const DUPLICATE_FINGERPRINT_WINDOW: usize = 1_024;
const CROSS_STREAM_WINDOW: usize = 1_024;
const DISPATCH_CURSOR_PREFIX: &[u8] = b"scraper_websocket_dispatch_cursor";
const GAS_PAYMENT_CURSOR_PREFIX: &[u8] = b"scraper_websocket_gas_payment_stream_cursor_v2";
const GAS_PAYMENT_DEGRADED_PREFIX: &[u8] = b"scraper_websocket_gas_payment_degraded_v1";
const MERKLE_CURSOR_PREFIX: &[u8] = b"scraper_websocket_merkle_cursor";
const CORRELATION_CURSOR_PREFIX: &[u8] = b"scraper_websocket_correlation_cursor";
const PARITY_UNHEALTHY_PREFIX: &[u8] = b"scraper_websocket_parity_unhealthy";

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
    chain: String,
    cursor_db: HyperlaneRocksDB,
    domain: u32,
    interchain_gas_paymaster: H256,
    mailbox: H256,
    merkle_tree_hook: H256,
    database: Arc<dyn ParityDatabase>,
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
            chain,
            cursor_db: database.clone(),
            domain,
            interchain_gas_paymaster,
            mailbox,
            merkle_tree_hook,
            database: Arc::new(database),
        }
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

    fn correlation_cursor_key(&self) -> H512 {
        let mut key = [0_u8; 64];
        key[..32].copy_from_slice(self.mailbox.as_ref());
        key[32..].copy_from_slice(self.merkle_tree_hook.as_ref());
        H512::from_slice(&key)
    }

    fn correlation_cursor(&self) -> Result<Option<u32>> {
        self.cursor_db
            .retrieve_value_by_key(CORRELATION_CURSOR_PREFIX, &self.correlation_cursor_key())
            .context("Reading durable scraper correlation cursor")
    }

    fn store_correlation_cursor(&self, sequence: u32) -> Result<()> {
        if self
            .correlation_cursor()?
            .is_some_and(|stored| stored >= sequence)
        {
            return Ok(());
        }
        self.cursor_db
            .store_value_by_key(
                CORRELATION_CURSOR_PREFIX,
                &self.correlation_cursor_key(),
                &sequence,
            )
            .context("Storing durable scraper correlation cursor")
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
    correlation_next: Option<u32>,
    floor: Option<u32>,
}

#[derive(Debug, Default)]
struct SequencedReplayPlan {
    sources: HashMap<u32, SequencedReplaySource>,
}

impl SequencedReplayPlan {
    fn load(sources: &HashMap<u32, ScraperSource>) -> Result<Self> {
        let mut plan = Self::default();
        for source in sources.values() {
            let dispatch = source.cursor(EventKind::Dispatch)?;
            let merkle = source.cursor(EventKind::MerkleTreeInsertion)?;
            let correlation = source.correlation_cursor()?;
            let floor = [dispatch, merkle, correlation].into_iter().flatten().min();
            let correlation_next = correlation.or(floor);
            if correlation.is_none() {
                if let Some(sequence) = correlation_next {
                    source.store_correlation_cursor(sequence)?;
                }
            }
            plan.sources.insert(
                source.domain,
                SequencedReplaySource {
                    correlation_next,
                    floor,
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

    fn correlation_required(&self, domain: u32) -> Result<bool> {
        Ok(self.source(domain)?.floor.is_some())
    }
}

#[derive(Debug, Eq, PartialEq)]
enum SequenceResult {
    Accepted,
    Duplicate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProtocolProjection {
    block_number: u64,
    message_id: H256,
}

#[derive(Debug, Default)]
struct CrossStreamPair {
    dispatch: Option<ProtocolProjection>,
    merkle: Option<ProtocolProjection>,
}

impl CrossStreamPair {
    fn complete(&self) -> bool {
        self.dispatch.is_some() && self.merkle.is_some()
    }

    fn get(&self, kind: EventKind) -> Option<ProtocolProjection> {
        match kind {
            EventKind::Dispatch => self.dispatch,
            EventKind::GasPayment => None,
            EventKind::MerkleTreeInsertion => self.merkle,
        }
    }

    fn get_mut(&mut self, kind: EventKind) -> &mut Option<ProtocolProjection> {
        match kind {
            EventKind::Dispatch => &mut self.dispatch,
            EventKind::GasPayment => unreachable!("gas payments are not cross-stream events"),
            EventKind::MerkleTreeInsertion => &mut self.merkle,
        }
    }
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

#[derive(Debug, Default)]
struct CrossStreamState {
    entries: HashMap<u32, BTreeMap<u32, CrossStreamPair>>,
}

impl CrossStreamState {
    fn complete(&self, domain: u32, sequence: u32) -> bool {
        self.entries
            .get(&domain)
            .and_then(|entries| entries.get(&sequence))
            .is_some_and(CrossStreamPair::complete)
    }

    fn validate(
        &mut self,
        domain: u32,
        sequence: u32,
        kind: EventKind,
        projection: ProtocolProjection,
    ) -> Result<()> {
        let entries = self.entries.entry(domain).or_default();

        let mismatch = if let Some(pair) = entries.get(&sequence) {
            if let Some(previous) = pair.get(kind) {
                if previous != projection {
                    bail!("Conflicting scraper projection at sequence {sequence}");
                }
            }
            if let Some(counterpart) = pair.get(match kind {
                EventKind::Dispatch => EventKind::MerkleTreeInsertion,
                EventKind::GasPayment => {
                    unreachable!("gas payments are not cross-stream events")
                }
                EventKind::MerkleTreeInsertion => EventKind::Dispatch,
            }) {
                if counterpart.message_id != projection.message_id {
                    Some(format!(
                        "Dispatch and Merkle message IDs differ at sequence {sequence}"
                    ))
                } else if counterpart.block_number != projection.block_number {
                    Some(format!(
                        "Dispatch and Merkle block numbers differ at sequence {sequence}"
                    ))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };
        if let Some(mismatch) = mismatch {
            bail!(mismatch);
        }
        if !entries.contains_key(&sequence) && entries.len() >= CROSS_STREAM_WINDOW {
            let oldest_complete = entries
                .first_key_value()
                .is_some_and(|(_, pair)| pair.complete());
            if !oldest_complete {
                bail!("Scraper cross-stream skew exceeds {CROSS_STREAM_WINDOW} sequences");
            }
        }

        if !entries.contains_key(&sequence) && entries.len() >= CROSS_STREAM_WINDOW {
            entries.pop_first();
        }
        let pair = entries.entry(sequence).or_default();
        *pair.get_mut(kind) = Some(projection);
        Ok(())
    }
}

#[derive(Debug)]
struct ValidatedEvent {
    gas_payment_cursor: Option<DurableGasPaymentCursor>,
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
        let Some(frontier) = sequenced_persistence_frontier(plan, caught_up, state, domain)? else {
            return Ok(VecDeque::new());
        };
        let events = self
            .events
            .remove(&domain)
            .expect("checked staged parity domain exists");
        let mut ready = VecDeque::new();
        let mut retained = VecDeque::new();
        for event in events {
            if event.sequence <= frontier {
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
                if local_message.as_ref().is_some_and(|local| local != message)
                    || local_block_number.is_some_and(|local| local != *block_number)
                    || local_transaction_id.is_some_and(|local| local != *transaction_id)
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
    correlation_next: HashMap<u32, u32>,
    cross_stream: CrossStreamState,
    cursors: HashMap<(u32, EventKind), StreamCursor>,
    gas_payment_degraded: HashSet<u32>,
    gas_payment_rows: HashMap<u32, DurableGasPaymentCursor>,
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
            }
        }
        Ok(state)
    }

    fn reset_sequenced(&mut self, plan: &SequencedReplayPlan) {
        self.correlation_next.clear();
        self.cross_stream = CrossStreamState::default();
        self.cursors.clear();
        for (domain, source) in &plan.sources {
            if let Some(sequence) = source.floor {
                for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
                    self.cursors.insert(
                        (*domain, kind),
                        StreamCursor::from_durable_sequence(sequence),
                    );
                }
            }
            if let Some(sequence) = source.correlation_next {
                self.correlation_next.insert(*domain, sequence);
            }
        }
    }

    fn advance_correlation(&mut self, domain: u32) -> Result<Option<u32>> {
        let Some(initial) = self.correlation_next.get(&domain).copied() else {
            return Ok(None);
        };
        let mut next = initial;
        while self.cross_stream.complete(domain, next) {
            next = next
                .checked_add(1)
                .context("Scraper correlation cursor exhausted")?;
        }
        if next == initial {
            return Ok(None);
        }
        self.correlation_next.insert(domain, next);
        Ok(Some(next))
    }

    fn initialize_correlation(&mut self, domain: u32, sequence: u32) -> Option<u32> {
        if self.correlation_next.contains_key(&domain) {
            return None;
        }
        self.correlation_next.insert(domain, sequence);
        Some(sequence)
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
        if sequence < 0 {
            return Ok(());
        }
        let Some(first) = self
            .cursors
            .get(&(domain, kind))
            .and_then(|cursor| cursor.first_sequence)
        else {
            return Ok(());
        };
        let baseline: u32 = sequence
            .try_into()
            .context("Scraper caught-up sequence exceeds u32")?;
        let expected = baseline
            .checked_add(1)
            .context("Scraper caught-up sequence exhausted")?;
        if first != expected {
            bail!(
                "Fresh {} scraper stream started at sequence {first}, expected {expected} after caught-up baseline {baseline}",
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

    #[cfg(test)]
    fn has_cursor(&self, domain: u32, kind: EventKind) -> bool {
        self.cursors.contains_key(&(domain, kind))
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

        let (kind, fingerprint, projection, parity) = match event.event_type.as_str() {
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
                    ProtocolProjection {
                        block_number: origin_block_height,
                        message_id,
                    },
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
                if data.domain != event.domain {
                    bail!("Merkle payload domain does not match event envelope");
                }
                let merkle_tree_hook = parse_address(&data.merkle_tree_hook)?;
                if merkle_tree_hook != source.merkle_tree_hook {
                    bail!("Merkle event hook does not match configured hook");
                }
                let leaf_index = data.leaf_index.as_u32("Merkle leaf index")?;
                if leaf_index != sequence {
                    bail!("Merkle leaf index does not match stream sequence");
                }
                let block_number = data.block_number.as_u64("Merkle block number")?;
                let block_number_bytes = block_number.to_be_bytes();
                let message_id = parse_h256(&data.message_id, "Merkle message ID")?;
                (
                    EventKind::MerkleTreeInsertion,
                    event_fingerprint(&[
                        b"merkle_tree_insertion",
                        &block_number_bytes,
                        merkle_tree_hook.as_ref(),
                        message_id.as_ref(),
                    ]),
                    ProtocolProjection {
                        block_number,
                        message_id,
                    },
                    ParityInput::MerkleTreeInsertion {
                        block_number,
                        insertion: MerkleTreeInsertion::new(leaf_index, message_id),
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
        self.cross_stream
            .validate(event.domain, sequence, kind, projection)?;
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
            gas_payment_cursor: None,
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
        parse_h256(&data.msg_id, "gas payment message ID")?;
        data.payment
            .parse::<U256>()
            .context("Invalid gas payment amount")?;
        data.gas_amount
            .parse::<U256>()
            .context("Invalid gas payment gas amount")?;
        data.log_index
            .parse::<U256>()
            .context("Invalid gas payment log index")?;
        data.tx_id
            .parse::<u64>()
            .context("Invalid gas payment transaction row ID")?;
        if let Some(sequence) = &data.sequence {
            sequence
                .parse::<u32>()
                .context("Invalid gas payment sequence")?;
        }
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
        let (result, cursor) = match self.gas_payment_rows.get(&event.domain) {
            Some(previous) if legacy_max_stream_cursor != previous.legacy_max_stream_cursor => {
                bail!("Gas payment legacy cursor boundary changed");
            }
            Some(previous) if stream_cursor < previous.stream_cursor => {
                bail!("Gas payment stream cursor moved backwards");
            }
            Some(previous) if stream_cursor == previous.stream_cursor => {
                if previous
                    .fingerprint
                    .is_some_and(|previous| fingerprint != previous)
                {
                    bail!("Conflicting gas payment event at stream cursor {stream_cursor}");
                }
                (
                    SequenceResult::Duplicate,
                    DurableGasPaymentCursor {
                        fingerprint: Some(fingerprint),
                        ..*previous
                    },
                )
            }
            Some(previous) => {
                let expected = previous
                    .stream_cursor
                    .checked_add(1)
                    .context("Gas payment stream cursor exhausted")?;
                if stream_cursor > legacy_max_stream_cursor && stream_cursor != expected {
                    return Err(StreamGap {
                        expected,
                        received: stream_cursor,
                    }
                    .into());
                }
                (
                    SequenceResult::Accepted,
                    DurableGasPaymentCursor {
                        fingerprint: Some(fingerprint),
                        legacy_max_stream_cursor,
                        stream_cursor,
                    },
                )
            }
            None => bail!("Gas payment event arrived before caught-up baseline"),
        };
        Ok(ValidatedEvent {
            gas_payment_cursor: Some(cursor),
            kind: EventKind::GasPayment,
            parity: None,
            sequence: None,
            sequence_result: result,
        })
    }

    fn gas_payment_caught_up_cursor(
        &self,
        address: &str,
        domain: u32,
        legacy_max_stream_cursor: Option<&str>,
        row_id: Option<&str>,
        stream_cursor: Option<&str>,
        sequence: Option<&str>,
        sources: &HashMap<u32, ScraperSource>,
    ) -> Result<DurableGasPaymentCursor> {
        if row_id.is_some() || sequence.is_some() {
            bail!("Unexpected scraper caught-up marker");
        }
        let source = sources
            .get(&domain)
            .with_context(|| format!("Unexpected scraper caught-up domain {domain}"))?;
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
            None => Ok(DurableGasPaymentCursor {
                fingerprint: None,
                legacy_max_stream_cursor,
                stream_cursor,
            }),
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
        let cursor = self.gas_payment_caught_up_cursor(
            address,
            domain,
            Some("0"),
            row_id,
            stream_cursor,
            sequence,
            sources,
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
            .gas_payment_cursor
            .context("Validated gas payment has no cursor")?;
        self.persist_gas_payment_cursor(domain, cursor, |_| Ok(()))?;
        Ok(validated)
    }
}

#[derive(Debug, Default)]
struct HandshakeState {
    confirmed: bool,
    sent: bool,
}

impl HandshakeState {
    fn ready(&mut self) -> Result<()> {
        if self.sent {
            bail!("Received duplicate scraper-proxy ready message");
        }
        self.sent = true;
        Ok(())
    }

    fn subscribed(
        &mut self,
        streams: &[SubscribedStream],
        sources: &HashMap<u32, ScraperSource>,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
        gas_payment_enabled: bool,
    ) -> Result<()> {
        if !self.sent {
            bail!("Received subscribed before ready");
        }
        if self.confirmed {
            bail!("Received duplicate scraper-proxy subscribed message");
        }
        validate_subscription(
            streams,
            sources,
            plan,
            gas_payment_cursors,
            gas_payment_enabled,
        )?;
        self.confirmed = true;
        Ok(())
    }

    fn event(&self) -> Result<()> {
        if !self.confirmed {
            bail!("Received scraper event before subscription confirmation");
        }
        Ok(())
    }
}

struct ParityJob {
    generation: u64,
    input: ParityInput,
    queue_permit: OwnedSemaphorePermit,
    sequence: u32,
}

#[derive(Default)]
struct ParityQueue {
    jobs: VecDeque<ParityJob>,
    worker_running: bool,
}

#[derive(Debug, Default)]
struct CorrelationGateSource {
    cross_next: Option<u32>,
    dispatch_match: Option<u32>,
    durable_next: Option<u32>,
    failed: bool,
    merkle_match: Option<u32>,
}

impl CorrelationGateSource {
    fn anchored(next: Option<u32>) -> Self {
        Self {
            cross_next: next,
            dispatch_match: None,
            durable_next: next,
            failed: false,
            merkle_match: None,
        }
    }

    fn matched_mut(&mut self, kind: EventKind) -> &mut Option<u32> {
        match kind {
            EventKind::Dispatch => &mut self.dispatch_match,
            EventKind::GasPayment => unreachable!("gas payments do not enter parity correlation"),
            EventKind::MerkleTreeInsertion => &mut self.merkle_match,
        }
    }

    fn candidate(&self) -> Result<Option<u32>> {
        let (Some(cross_next), Some(dispatch_match), Some(merkle_match)) =
            (self.cross_next, self.dispatch_match, self.merkle_match)
        else {
            return Ok(None);
        };
        let dispatch_next = dispatch_match
            .checked_add(1)
            .context("Dispatch parity frontier exhausted")?;
        let merkle_next = merkle_match
            .checked_add(1)
            .context("Merkle parity frontier exhausted")?;
        Ok(Some(cross_next.min(dispatch_next).min(merkle_next)))
    }
}

#[derive(Debug, Default)]
struct CorrelationGate {
    generation: u64,
    sources: HashMap<u32, CorrelationGateSource>,
}

/// One process-wide, read-only scraper stream monitor.
pub(crate) struct ScraperWebSocketMonitor {
    active: IntGaugeVec,
    caught_up: IntGaugeVec,
    degraded: IntGaugeVec,
    correlation_gate: parking_lot::Mutex<CorrelationGate>,
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
    pub(crate) fn new(
        url: Url,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
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
        let mut parity_unhealthy = HashSet::new();
        let mut parity_queues = HashMap::new();
        for source in sources.values() {
            active.with_label_values(&[source.chain.as_str()]).set(0);
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
            caught_up,
            degraded,
            correlation_gate: parking_lot::Mutex::new(CorrelationGate::default()),
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

    pub(crate) async fn run(self) {
        let monitor = Arc::new(self);
        let mut generation = 0_u64;
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
            let Some(next_generation) = generation.checked_add(1) else {
                warn!("Scraper WebSocket connection generation exhausted; stopping monitor");
                return;
            };
            generation = next_generation;
            state.reset_sequenced(&plan);
            monitor.reset_correlation_gate(generation, &plan);
            monitor.set_active(false);
            monitor.set_caught_up(false);
            let gas_payment_cursors = monitor.gas_payment_cursors(&state);
            match monitor
                .stream(&mut state, &plan, &gas_payment_cursors, generation)
                .await
            {
                Ok(()) => warn!("Relayer scraper-proxy shadow stream closed; reconnecting"),
                Err(err) => warn!(
                    ?err,
                    "Relayer scraper-proxy shadow stream failed; reconnecting"
                ),
            }
            monitor.set_active(false);
            monitor.set_caught_up(false);
            sleep(RETRY_DELAY).await;
        }
    }

    fn reset_correlation_gate(&self, generation: u64, plan: &SequencedReplayPlan) {
        let sources = plan
            .sources
            .iter()
            .map(|(domain, source)| {
                (
                    *domain,
                    CorrelationGateSource::anchored(source.correlation_next),
                )
            })
            .collect();
        *self.correlation_gate.lock() = CorrelationGate {
            generation,
            sources,
        };
    }

    fn anchor_correlation_gate(&self, generation: u64, domain: u32, sequence: u32) {
        let mut gate = self.correlation_gate.lock();
        if gate.generation != generation {
            return;
        }
        gate.sources
            .entry(domain)
            .and_modify(|source| {
                if source.durable_next.is_none() {
                    *source = CorrelationGateSource::anchored(Some(sequence));
                }
            })
            .or_insert_with(|| CorrelationGateSource::anchored(Some(sequence)));
    }

    fn note_cross_stream_next(&self, generation: u64, domain: u32, next: u32) {
        let mut gate = self.correlation_gate.lock();
        if gate.generation != generation {
            return;
        }
        if let Some(source) = gate.sources.get_mut(&domain) {
            source.cross_next = Some(source.cross_next.map_or(next, |current| current.max(next)));
        }
    }

    fn finish_parity_correlation(
        &self,
        generation: u64,
        domain: u32,
        kind: EventKind,
        sequence: u32,
        terminal: &'static str,
    ) -> Result<()> {
        let source = self
            .sources
            .get(&domain)
            .context("Validated scraper source is missing")?;
        let mut gate = self.correlation_gate.lock();
        if generation == 0 {
            return Ok(());
        }
        if gate.generation != generation {
            return Ok(());
        }
        let state = gate
            .sources
            .get_mut(&domain)
            .context("Correlation gate omitted configured source")?;
        if state.failed {
            return Ok(());
        }
        if terminal != ParityResult::Match.label() {
            state.failed = true;
            return Ok(());
        }

        let durable_next = state
            .durable_next
            .context("Correlation parity frontier is not anchored")?;
        let matched = state.matched_mut(kind);
        let expected = match *matched {
            Some(latest) => latest
                .checked_add(1)
                .context("Scraper parity frontier exhausted")?,
            None => durable_next,
        };
        if sequence < expected {
            return Ok(());
        }
        if sequence > expected {
            state.failed = true;
            bail!("Scraper parity frontier gap: expected sequence {expected}, received {sequence}");
        }
        *matched = Some(sequence);

        let Some(candidate) = state.candidate()? else {
            return Ok(());
        };
        if state
            .durable_next
            .is_some_and(|durable| durable >= candidate)
        {
            return Ok(());
        }
        if let Err(err) = source.store_correlation_cursor(candidate) {
            state.failed = true;
            return Err(err);
        }
        state.durable_next = Some(candidate);
        Ok(())
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
        let database = source.database.clone();
        let mut terminal = None;
        for attempt in 1..=PARITY_RETRY_ATTEMPTS {
            if self.parity_read_disabled.load(Ordering::Acquire) {
                terminal = Some("error");
                break;
            }
            let database = database.clone();
            let parity_input = parity_input.clone();
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
            let mut comparison = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                parity_input.compare(database.as_ref())
            });
            match timeout(PARITY_READ_TIMEOUT, &mut comparison).await {
                Err(_) => {
                    self.disable_parity_reads(&chain, event_type, "blocking read timed out");
                    terminal = Some("error");
                    break;
                }
                Ok(Ok(Ok(ParityResult::Missing))) if attempt < PARITY_RETRY_ATTEMPTS => {
                    sleep(PARITY_RETRY_DELAY).await;
                }
                Ok(Ok(Ok(ParityResult::Missing))) => {
                    terminal = Some("expired");
                    break;
                }
                Ok(Ok(Ok(result))) => {
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
            if should_warn(&self.parity_warned_at) {
                warn!(%chain, event_type, result = terminal, "Scraper event did not reach matching local DB parity");
            }
        }
        let pending = self.parity_pending.with_label_values(&labels);
        pending.dec();
        if pending.get() == 0 && !self.parity_unhealthy.lock().contains(&(domain, kind)) {
            self.parity_ready.with_label_values(&labels).set(1);
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
        }
    }

    async fn enqueue_accounted_parity(
        self: &Arc<Self>,
        domain: u32,
        kind: EventKind,
        parity_input: ParityInput,
        sequence: u32,
    ) -> bool {
        let generation = self.correlation_gate.lock().generation;
        if self.parity_read_disabled.load(Ordering::Acquire) {
            return false;
        }
        let queue_permit = self
            .parity_queue_permit
            .clone()
            .acquire_owned()
            .await
            .expect("parity queue semaphore is never closed");
        if self.parity_read_disabled.load(Ordering::Acquire) {
            return false;
        }
        let queue = self
            .parity_queues
            .get(&(domain, kind))
            .expect("validated scraper stream has a parity queue")
            .clone();
        let start_worker = {
            let mut queue = queue.lock();
            queue.jobs.push_back(ParityJob {
                generation,
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
        true
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
            .await;
        if !enqueued {
            self.cancel_parity_pending(domain, kind);
        }
        enqueued
    }

    async fn admit_parity(
        self: &Arc<Self>,
        state: &mut StreamState,
        generation: u64,
        domain: u32,
        validated: StagedParityEvent,
    ) -> Result<()> {
        if let Some(sequence) = state.initialize_correlation(domain, validated.sequence) {
            let source = self
                .sources
                .get(&domain)
                .context("Validated scraper source is missing")?;
            source.store_correlation_cursor(sequence)?;
            self.anchor_correlation_gate(generation, domain, sequence);
        }
        if let Some(next) = state.advance_correlation(domain)? {
            self.note_cross_stream_next(generation, domain, next);
        }
        if !self
            .enqueue_accounted_parity(domain, validated.kind, validated.parity, validated.sequence)
            .await
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
        generation: u64,
        domain: u32,
        staged: &mut StagedParity,
    ) -> Result<()> {
        let mut ready = staged.drain_ready(plan, caught_up, state, domain)?;
        while let Some(validated) = ready.pop_front() {
            let kind = validated.kind;
            if let Err(err) = self
                .admit_parity(state, generation, domain, validated)
                .await
            {
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
            if let Err(err) =
                self.finish_parity_correlation(job.generation, domain, kind, job.sequence, terminal)
            {
                warn!(%domain, event_type = kind.label(), ?err, "Persisting scraper correlation cursor failed; disabling parity work");
                self.disable_parity_reads(
                    source.chain.as_str(),
                    kind.label(),
                    "durable correlation cursor could not be persisted",
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
        self.reset_correlation_gate(1, &plan);
        self.set_active(false);
        self.set_caught_up(false);
        let result = self.stream(state, &plan, &gas_payment_cursors, 1).await;
        self.set_active(false);
        self.set_caught_up(false);
        result
    }

    async fn stream(
        self: &Arc<Self>,
        state: &mut StreamState,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
        generation: u64,
    ) -> Result<()> {
        let mut staged_parity = StagedParity::default();
        let result = self
            .stream_inner(
                state,
                plan,
                gas_payment_cursors,
                generation,
                &mut staged_parity,
            )
            .await;
        self.abandon_staged_parity(&mut staged_parity);
        result
    }

    async fn stream_inner(
        self: &Arc<Self>,
        state: &mut StreamState,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
        generation: u64,
        staged_parity: &mut StagedParity,
    ) -> Result<()> {
        let (mut socket, _) = timeout(READ_TIMEOUT, connect_async(self.url.as_str()))
            .await
            .context("Connecting to relayer scraper-proxy WebSocket timed out")?
            .context("Connecting to relayer scraper-proxy WebSocket")?;
        let mut handshake = HandshakeState::default();
        let mut caught_up = HashMap::new();
        let mut gas_payment_caught_up = HashSet::new();
        let read_deadline = sleep(READ_TIMEOUT);
        tokio::pin!(read_deadline);

        while let Some(message) = tokio::select! {
            _ = &mut read_deadline => bail!("Relayer scraper-proxy WebSocket heartbeat timed out"),
            message = socket.next() => message,
        } {
            let next_read_deadline = Instant::now()
                .checked_add(READ_TIMEOUT)
                .expect("read timeout cannot exceed Instant range");
            read_deadline.as_mut().reset(next_read_deadline);
            match message.context("Reading relayer scraper-proxy WebSocket message")? {
                Message::Text(text) => {
                    let message: ServerMessage<serde_json::Value> = serde_json::from_str(&text)
                        .context("Parsing relayer scraper-proxy WebSocket message")?;
                    match message {
                        ServerMessage::Ready {
                            stream_cursor_versions,
                        } => {
                            handshake.ready()?;
                            let gas_payment_enabled = stream_cursor_versions
                                .get(GAS_PAYMENT_EVENT_TYPE)
                                == Some(&GAS_PAYMENT_STREAM_CURSOR_VERSION);
                            self.gas_payment_enabled
                                .store(gas_payment_enabled, Ordering::Relaxed);
                            for source in self.sources.values() {
                                self.set_source_caught_up(source, EventKind::GasPayment, false);
                                self.degraded
                                    .with_label_values(&[
                                        source.chain.as_str(),
                                        GAS_PAYMENT_EVENT_TYPE,
                                    ])
                                    .set(i64::from(
                                        !gas_payment_enabled || source.gas_payment_degraded()?,
                                    ));
                            }
                            socket
                                .send(Message::Text(self.subscription(plan, gas_payment_cursors)?))
                                .await
                                .context("Subscribing to relayer scraper-proxy streams")?;
                        }
                        ServerMessage::Subscribed { streams } => {
                            let gas_payment_enabled =
                                self.gas_payment_enabled.load(Ordering::Relaxed);
                            handshake.subscribed(
                                &streams,
                                &self.sources,
                                plan,
                                gas_payment_cursors,
                                gas_payment_enabled,
                            )?;
                            self.set_active(true);
                            info!("Relayer scraper-proxy shadow streams active");
                        }
                        ServerMessage::Event(event) => {
                            handshake.event()?;
                            let domain = event.domain;
                            let is_gas_payment = event.event_type == GAS_PAYMENT_EVENT_TYPE;
                            let event_type = event_label(&event.event_type);
                            if is_gas_payment && !self.gas_payment_enabled.load(Ordering::Relaxed) {
                                bail!(
                                    "Received gas payment event without negotiated cursor support"
                                );
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
                                            generation,
                                            domain,
                                            staged_parity,
                                        )
                                        .await?;
                                        self.update_source_caught_up(
                                            state, plan, &caught_up, domain,
                                        )?;
                                    } else {
                                        let source = self.sources.get(&domain).context(
                                            "Validated scraper event source unexpectedly missing",
                                        )?;
                                        state.persist_gas_payment_cursor(
                                            domain,
                                            validated
                                                .gas_payment_cursor
                                                .context("Validated gas payment has no cursor")?,
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
                                    let source = self.sources.get(&domain).context(
                                        "Invalid gas payment source unexpectedly missing",
                                    )?;
                                    source.store_gas_payment_degraded()?;
                                    if state.gas_payment_degraded.insert(domain) {
                                        self.set_source_caught_up(
                                            source,
                                            EventKind::GasPayment,
                                            false,
                                        );
                                        self.degraded
                                            .with_label_values(&[
                                                source.chain.as_str(),
                                                GAS_PAYMENT_EVENT_TYPE,
                                            ])
                                            .set(1);
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
                            handshake.event()?;
                            if event_type == GAS_PAYMENT_EVENT_TYPE {
                                if !self.gas_payment_enabled.load(Ordering::Relaxed) {
                                    bail!("Received gas payment caught-up marker without negotiated cursor support");
                                }
                                if state.gas_payment_degraded.contains(&domain) {
                                    self.record(domain, GAS_PAYMENT_EVENT_TYPE, "degraded");
                                    continue;
                                }
                                let cursor = state.gas_payment_caught_up_cursor(
                                    &address,
                                    domain,
                                    legacy_max_stream_cursor.as_deref(),
                                    row_id.as_deref(),
                                    stream_cursor.as_deref(),
                                    sequence.as_deref(),
                                    &self.sources,
                                )?;
                                let source = self.sources.get(&domain).with_context(|| {
                                    format!("Unexpected scraper caught-up domain {domain}")
                                })?;
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
                            let source = self.sources.get(&domain).with_context(|| {
                                format!("Unexpected scraper caught-up domain {domain}")
                            })?;
                            if parse_address(&address)? != source.address(kind) {
                                bail!(
                                    "Scraper caught-up address does not match configured contract"
                                );
                            }
                            let sequence = sequence
                                .as_deref()
                                .context("Sequenced scraper caught-up marker omitted sequence")?
                                .parse::<i64>()
                                .context("Invalid scraper caught-up sequence")?;
                            if sequence < -1 {
                                bail!("Invalid negative scraper caught-up sequence {sequence}");
                            }
                            validate_caught_up_floor(plan, domain, sequence)?;
                            if !plan.correlation_required(domain)? {
                                state.validate_fresh_baseline(domain, kind, sequence)?;
                            }
                            state.set_baseline(domain, kind, sequence)?;
                            if caught_up.insert((domain, kind), sequence).is_some() {
                                bail!("Received duplicate scraper caught-up marker");
                            }
                            if !plan.correlation_required(domain)?
                                && !state.correlation_next.contains_key(&domain)
                            {
                                let parity_pending =
                                    [EventKind::Dispatch, EventKind::MerkleTreeInsertion]
                                        .into_iter()
                                        .map(|kind| {
                                            self.parity_pending
                                                .with_label_values(&[
                                                    source.chain.as_str(),
                                                    kind.label(),
                                                ])
                                                .get()
                                        })
                                        .sum::<i64>();
                                if parity_pending == 0 {
                                    if let Some(baselines) =
                                        fresh_baseline_write_order(&caught_up, domain)?
                                    {
                                        for (kind, sequence) in baselines {
                                            source.store_cursor(kind, sequence)?;
                                        }
                                    }
                                }
                            }
                            self.flush_staged_parity(
                                state,
                                plan,
                                &caught_up,
                                generation,
                                domain,
                                staged_parity,
                            )
                            .await?;
                            self.update_source_caught_up(state, plan, &caught_up, domain)?;
                        }
                        ServerMessage::Error { error } => {
                            if self.gas_payment_enabled.load(Ordering::Relaxed)
                                && is_unsupported_row_cursor_error(&error)
                            {
                                self.gas_payment_enabled.store(false, Ordering::Relaxed);
                                for source in self.sources.values() {
                                    self.set_source_caught_up(source, EventKind::GasPayment, false);
                                    self.degraded
                                        .with_label_values(&[
                                            source.chain.as_str(),
                                            GAS_PAYMENT_EVENT_TYPE,
                                        ])
                                        .set(1);
                                }
                                bail!("Scraper-proxy lacks gas payment row cursor support; retrying sequenced streams only");
                            }
                            bail!("Scraper-proxy rejected relayer shadow stream: {error}")
                        }
                        ServerMessage::Other => {}
                    }
                }
                Message::Ping(payload) => socket
                    .send(Message::Pong(payload))
                    .await
                    .context("Responding to relayer scraper-proxy heartbeat")?,
                Message::Close(frame) => {
                    bail!("Relayer scraper-proxy WebSocket closed: {frame:?}")
                }
                Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
            }
        }
        Ok(())
    }

    fn subscription(
        &self,
        plan: &SequencedReplayPlan,
        gas_payment_cursors: &[SubscribedCursor],
    ) -> Result<String> {
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
                    .gas_payment_rows
                    .get(&source.domain)
                    .map(|cursor| cursor.stream_cursor.to_string()),
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

    fn update_source_caught_up(
        &self,
        state: &StreamState,
        plan: &SequencedReplayPlan,
        caught_up: &HashMap<(u32, EventKind), i64>,
        domain: u32,
    ) -> Result<()> {
        if !source_caught_up(plan.correlation_required(domain)?, caught_up, state, domain)? {
            return Ok(());
        }
        let source = self
            .sources
            .get(&domain)
            .context("Validated scraper source is missing")?;
        for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
            self.set_source_caught_up(source, kind, true);
        }
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

#[cfg(test)]
fn fresh_baseline_allowed(
    correlation_required: bool,
    replay_seen: bool,
    parity_pending: i64,
) -> bool {
    !correlation_required && !replay_seen && parity_pending == 0
}

#[cfg(test)]
fn store_fresh_caught_up_baseline(
    source: &ScraperSource,
    kind: EventKind,
    sequence: i64,
    replay_floor: Option<u32>,
    correlation_required: bool,
    replay_seen: bool,
    parity_pending: i64,
) -> Result<()> {
    if replay_floor.is_none()
        && sequence >= 0
        && fresh_baseline_allowed(correlation_required, replay_seen, parity_pending)
    {
        let durable: u32 = sequence
            .try_into()
            .context("Scraper caught-up sequence exceeds u32")?;
        source.store_cursor(kind, durable)?;
    }
    Ok(())
}

fn subscription(
    sources: &HashMap<u32, ScraperSource>,
    plan: &SequencedReplayPlan,
    gas_payment_cursors: &[SubscribedCursor],
    gas_payment_enabled: bool,
) -> Result<String> {
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
    serde_json::to_string(&SubscribeMessage {
        streams,
        message_type: "subscribe",
    })
    .context("Serializing relayer scraper-proxy subscription")
}

fn sequence_cursor(
    source: &ScraperSource,
    kind: EventKind,
    plan: &SequencedReplayPlan,
) -> Result<SequenceCursor> {
    Ok(SequenceCursor {
        address: scraper_address(source.address(kind)),
        allow_replay: Some(true),
        after_sequence: plan.source(source.domain)?.floor.map(replay_after_sequence),
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

fn validate_caught_up_floor(plan: &SequencedReplayPlan, domain: u32, sequence: i64) -> Result<()> {
    if let Some(floor) = plan.source(domain)?.floor {
        if sequence < i64::from(floor) {
            bail!("Scraper caught-up sequence {sequence} is behind replay floor {floor}");
        }
    }
    Ok(())
}

fn correlation_ready(
    required: bool,
    state: &StreamState,
    domain: u32,
    sequence: i64,
) -> Result<bool> {
    if sequence < 0 || !required {
        return Ok(true);
    }
    Ok(state.cross_stream.complete(
        domain,
        sequence
            .try_into()
            .context("Caught-up sequence exceeds u32")?,
    ))
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

fn validate_fresh_empty_stream_starts(state: &StreamState, domain: u32) -> Result<()> {
    for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
        let Some(cursor) = state.cursors.get(&(domain, kind)) else {
            continue;
        };
        let first = cursor
            .first_sequence
            .context("Fresh scraper stream cursor omitted its first fingerprint")?;
        if first != 0 {
            bail!(
                "Fresh empty {} scraper stream started at sequence {first}, expected 0",
                kind.label()
            );
        }
    }
    Ok(())
}

fn sequenced_persistence_frontier(
    plan: &SequencedReplayPlan,
    caught_up: &HashMap<(u32, EventKind), i64>,
    state: &StreamState,
    domain: u32,
) -> Result<Option<u32>> {
    if plan.correlation_required(domain)? {
        return Ok(Some(u32::MAX));
    }
    let Some((dispatch, merkle)) = caught_up_baselines(caught_up, domain) else {
        return Ok(None);
    };
    if dispatch != merkle {
        return Ok(None);
    }
    if dispatch >= 0 {
        return Ok(Some(u32::MAX));
    }
    validate_fresh_empty_stream_starts(state, domain)?;
    let mut sequence = state.correlation_next.get(&domain).copied().unwrap_or(0);
    let mut frontier = None;
    while state.cross_stream.complete(domain, sequence) {
        frontier = Some(sequence);
        let Some(next) = sequence.checked_add(1) else {
            break;
        };
        sequence = next;
    }
    Ok(frontier)
}

#[cfg(test)]
fn sequenced_persistence_ready(
    plan: &SequencedReplayPlan,
    caught_up: &HashMap<(u32, EventKind), i64>,
    state: &StreamState,
    domain: u32,
    sequence: u32,
) -> Result<bool> {
    Ok(
        sequenced_persistence_frontier(plan, caught_up, state, domain)?
            .is_some_and(|frontier| sequence <= frontier),
    )
}

fn cursor_write_order(dispatch: u32, merkle: u32) -> [(EventKind, u32); 2] {
    if dispatch <= merkle {
        [
            (EventKind::Dispatch, dispatch),
            (EventKind::MerkleTreeInsertion, merkle),
        ]
    } else {
        [
            (EventKind::MerkleTreeInsertion, merkle),
            (EventKind::Dispatch, dispatch),
        ]
    }
}

#[cfg(test)]
fn sequenced_cursor_write_order(state: &StreamState, domain: u32) -> Result<[(EventKind, u32); 2]> {
    Ok(cursor_write_order(
        state.latest_sequence(domain, EventKind::Dispatch)?,
        state.latest_sequence(domain, EventKind::MerkleTreeInsertion)?,
    ))
}

fn fresh_baseline_write_order(
    caught_up: &HashMap<(u32, EventKind), i64>,
    domain: u32,
) -> Result<Option<[(EventKind, u32); 2]>> {
    let Some((dispatch, merkle)) = caught_up_baselines(caught_up, domain) else {
        return Ok(None);
    };
    if dispatch < 0 || merkle < 0 {
        return Ok(None);
    }
    let dispatch: u32 = dispatch
        .try_into()
        .context("Scraper caught-up sequence exceeds u32")?;
    let merkle: u32 = merkle
        .try_into()
        .context("Scraper caught-up sequence exceeds u32")?;
    Ok(Some(cursor_write_order(dispatch, merkle)))
}

fn source_caught_up(
    correlation_required: bool,
    caught_up: &HashMap<(u32, EventKind), i64>,
    state: &StreamState,
    domain: u32,
) -> Result<bool> {
    let Some((dispatch, merkle)) = caught_up_baselines(caught_up, domain) else {
        return Ok(false);
    };
    if !correlation_required {
        if dispatch != merkle {
            bail!("Fresh scraper caught-up baselines differ: dispatch {dispatch}, Merkle {merkle}");
        }
        if dispatch < 0 {
            validate_fresh_empty_stream_starts(state, domain)?;
        }
        return Ok(true);
    }
    let target = dispatch.max(merkle);
    if target < 0 {
        return Ok(true);
    }
    let target: u32 = target
        .try_into()
        .context("Caught-up sequence exceeds u32")?;
    for kind in [EventKind::Dispatch, EventKind::MerkleTreeInsertion] {
        let Some(cursor) = state.cursors.get(&(domain, kind)) else {
            return Ok(false);
        };
        if cursor.latest_sequence()? < target {
            return Ok(false);
        }
    }
    if state
        .correlation_next
        .get(&domain)
        .is_none_or(|next| *next <= target)
    {
        return Ok(false);
    }
    correlation_ready(true, state, domain, i64::from(target))
}

fn validate_subscription(
    streams: &[SubscribedStream],
    sources: &HashMap<u32, ScraperSource>,
    plan: &SequencedReplayPlan,
    gas_payment_cursors: &[SubscribedCursor],
    gas_payment_enabled: bool,
) -> Result<()> {
    let expected_streams = if gas_payment_enabled { 3 } else { 2 };
    if streams.len() != expected_streams {
        bail!("Scraper-proxy confirmed an unexpected number of streams");
    }
    let mut sources = sources.values().collect::<Vec<_>>();
    sources.sort_unstable_by_key(|source| source.domain);
    let domains = sources
        .iter()
        .map(|source| source.domain)
        .collect::<Vec<_>>();
    for (stream, kind) in streams
        .iter()
        .zip([EventKind::Dispatch, EventKind::MerkleTreeInsertion])
    {
        let expected_cursors = sequenced_subscription_cursors(sources.as_slice(), kind, plan)?;
        if stream.event_type != kind.label()
            || stream.cursors.as_deref() != Some(expected_cursors.as_slice())
            || stream.domains.as_deref() != Some(domains.as_slice())
            || stream.stream_cursor_version.is_some()
        {
            bail!("Scraper-proxy subscription confirmation does not match request");
        }
    }
    if gas_payment_enabled {
        let gas_payment = &streams[2];
        if gas_payment.event_type != GAS_PAYMENT_EVENT_TYPE
            || gas_payment.cursors.as_deref() != Some(gas_payment_cursors)
            || gas_payment.domains.as_deref() != Some(domains.as_slice())
            || gas_payment.stream_cursor_version != Some(GAS_PAYMENT_STREAM_CURSOR_VERSION)
        {
            bail!("Scraper-proxy subscription confirmation does not match request");
        }
    }
    Ok(())
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
    payment: String,
    sequence: Option<String>,
    time_created: String,
    tx_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MerkleEventData {
    block_number: StringOrNumber,
    domain: u32,
    leaf_index: StringOrNumber,
    merkle_tree_hook: String,
    message_id: String,
}

fn parse_address(value: &str) -> Result<H256> {
    bytes_to_address(parse_hex(value)?).context("Invalid scraper event address")
}

fn scraper_address(address: H256) -> String {
    let bytes = address.as_bytes();
    if bytes[..12].iter().all(|byte| *byte == 0) {
        format!("0x{}", hex::encode(&bytes[12..]))
    } else {
        format!("{address:#x}")
    }
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
    use super::*;
    use hyperlane_base::db::{test_utils, DB};
    use hyperlane_core::HyperlaneDomain;
    use prometheus::Registry;
    use tokio::{net::TcpListener, sync::oneshot};
    use tokio_tungstenite::accept_async;

    struct Fixture {
        _temp_dir: tempfile::TempDir,
        database: HyperlaneRocksDB,
        sources: HashMap<u32, ScraperSource>,
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
        state.correlation_next.insert(5, 99);
        state.cursors.insert(
            (5, EventKind::Dispatch),
            StreamCursor::from_durable_sequence(99),
        );
        state.gas_payment_degraded.insert(5);
        state.gas_payment_rows.insert(5, cursor);

        state.reset_sequenced(&plan);

        assert!(state.correlation_next.is_empty());
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
        let initial: serde_json::Value = serde_json::from_str(
            &subscription(sources, &initial_plan, &initial_gas, true)
                .expect("initial subscription"),
        )
        .expect("initial subscription JSON");
        assert_eq!(initial["streams"][0]["cursors"][0]["afterSequence"], "89");
        assert_eq!(
            initial["streams"][2]["cursors"][0]["afterStreamCursor"],
            "41"
        );

        source
            .store_cursor(EventKind::MerkleTreeInsertion, 100)
            .expect("advance Merkle cursor");
        source
            .store_correlation_cursor(100)
            .expect("advance correlated cursor");
        let reconnect_plan = replay_plan(sources);
        state.reset_sequenced(&reconnect_plan);
        assert_eq!(state.gas_payment_rows[&5].stream_cursor, 41);
        let reconnect: serde_json::Value = serde_json::from_str(
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
    fn caught_up_does_not_jump_pending_replay_cursor() {
        let sources = sources();
        let source = &sources[&5];
        let mut replay = StreamState::default();
        replay
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"pending")),
                &sources,
            )
            .expect("replayed event");

        store_fresh_caught_up_baseline(
            source,
            EventKind::Dispatch,
            20,
            None,
            false,
            replay.has_cursor(5, EventKind::Dispatch),
            1,
        )
        .expect("skip baseline with replay pending");
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("cursor read"),
            None
        );

        store_fresh_caught_up_baseline(source, EventKind::Dispatch, 20, None, false, false, 0)
            .expect("store true fresh-start baseline");
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("cursor read"),
            Some(20)
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
    fn fresh_event_anchors_correlation_before_stream_cursor() {
        let sources = sources();
        let source = &sources[&5];
        let plan = replay_plan(&sources);
        let mut state = replay_state(&plan);
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("first event");

        let sequence = state
            .latest_sequence(5, EventKind::Dispatch)
            .expect("dispatch cursor");
        let anchor = state
            .initialize_correlation(5, sequence)
            .expect("fresh correlation anchor");
        source
            .store_correlation_cursor(anchor)
            .expect("store correlation anchor");
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            Some(7)
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );

        source
            .store_cursor(EventKind::Dispatch, sequence)
            .expect("store dispatch cursor");
        let restart_plan = replay_plan(&sources);
        assert_eq!(restart_plan.source(5).expect("source plan").floor, Some(7));
    }

    #[test]
    fn restart_replays_both_stream_boundaries_before_caught_up() {
        let sources = sources();
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 100)
            .expect("store dispatch cursor");
        source
            .store_cursor(EventKind::MerkleTreeInsertion, 90)
            .expect("store Merkle cursor");
        let initial_plan = replay_plan(&sources);
        assert_eq!(initial_plan.source(5).expect("source plan").floor, Some(90));
        let request: serde_json::Value = serde_json::from_str(
            &subscription(&sources, &initial_plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");
        assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "89");
        assert_eq!(request["streams"][1]["cursors"][0]["afterSequence"], "89");

        let mut healing = replay_state(&initial_plan);
        for sequence in 90_u32..=100 {
            let body = sequence.to_be_bytes();
            let message_id = dispatch_message(sequence, &body).id();
            healing
                .validate(
                    event(
                        MERKLE_EVENT_TYPE,
                        sequence,
                        merkle_data_for(sequence, H256::from_low_u64_be(2), message_id, 100),
                    ),
                    &sources,
                )
                .expect("replay Merkle event");
            source
                .store_cursor(EventKind::MerkleTreeInsertion, sequence)
                .expect("store Merkle cursor");
            assert_eq!(
                healing.advance_correlation(5).expect("advance correlation"),
                None
            );
        }
        for sequence in 90_u32..=95 {
            let body = sequence.to_be_bytes();
            if sequence == 95 {
                assert!(healing
                    .validate(
                        event(
                            DISPATCH_EVENT_TYPE,
                            sequence,
                            dispatch_data(sequence, b"wrong")
                        ),
                        &sources,
                    )
                    .expect_err("mismatch below high cursor must reject")
                    .to_string()
                    .contains("message IDs differ"));
            }
            healing
                .validate(
                    event(
                        DISPATCH_EVENT_TYPE,
                        sequence,
                        dispatch_data(sequence, &body),
                    ),
                    &sources,
                )
                .expect("replay dispatch event");
            source
                .store_cursor(EventKind::Dispatch, sequence)
                .expect("store dispatch cursor");
            if let Some(next) = healing.advance_correlation(5).expect("advance correlation") {
                source
                    .store_correlation_cursor(next)
                    .expect("store correlation cursor");
            }
        }
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            Some(96)
        );

        let restart_plan = replay_plan(&sources);
        assert_eq!(restart_plan.source(5).expect("source plan").floor, Some(96));
        let restart_subscription: serde_json::Value = serde_json::from_str(
            &subscription(&sources, &restart_plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");
        assert_eq!(
            restart_subscription["streams"][0]["cursors"][0]["afterSequence"],
            "95"
        );
        assert_eq!(
            restart_subscription["streams"][1]["cursors"][0]["afterSequence"],
            "95"
        );

        let mut restarted = replay_state(&restart_plan);
        for sequence in 96_u32..=100 {
            let body = sequence.to_be_bytes();
            let message_id = dispatch_message(sequence, &body).id();
            restarted
                .validate(
                    event(
                        DISPATCH_EVENT_TYPE,
                        sequence,
                        dispatch_data(sequence, &body),
                    ),
                    &sources,
                )
                .expect("replay dispatch event after crash");
            source
                .store_cursor(EventKind::Dispatch, sequence)
                .expect("store dispatch cursor");
            restarted
                .validate(
                    event(
                        MERKLE_EVENT_TYPE,
                        sequence,
                        merkle_data_for(sequence, H256::from_low_u64_be(2), message_id, 100),
                    ),
                    &sources,
                )
                .expect("replay Merkle event after crash");
            source
                .store_cursor(EventKind::MerkleTreeInsertion, sequence)
                .expect("store Merkle cursor");
            if let Some(next) = restarted
                .advance_correlation(5)
                .expect("advance correlation")
            {
                source
                    .store_correlation_cursor(next)
                    .expect("store correlation cursor");
            }
        }
        assert!((96_u32..=100).all(|sequence| restarted.cross_stream.complete(5, sequence)));
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            Some(101)
        );
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), 100),
            ((5, EventKind::MerkleTreeInsertion), 100),
        ]);
        assert!(source_caught_up(true, &caught_up, &restarted, 5).expect("readiness check"));
    }

    #[test]
    fn fresh_unequal_baselines_reconnect_at_common_floor() {
        let sources = sources();
        let source = &sources[&5];
        let initial_plan = replay_plan(&sources);
        assert!(!initial_plan
            .correlation_required(5)
            .expect("correlation requirement"));

        let mut state = replay_state(&initial_plan);
        state
            .set_baseline(5, EventKind::Dispatch, 100)
            .expect("set fresh dispatch baseline");
        let mut caught_up = HashMap::from([((5, EventKind::Dispatch), 100)]);
        assert!(!source_caught_up(false, &caught_up, &state, 5).expect("one fresh marker"));
        assert_eq!(
            fresh_baseline_write_order(&caught_up, 5).expect("baseline order"),
            None
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );

        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 101, dispatch_data(101, b"one-oh-one")),
                &sources,
            )
            .expect("fresh live event after first marker");
        assert!(
            !sequenced_persistence_ready(&initial_plan, &caught_up, &state, 5, 101)
                .expect("persistence readiness")
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            None
        );
        state
            .set_baseline(5, EventKind::MerkleTreeInsertion, 90)
            .expect("set fresh Merkle baseline");
        caught_up.insert((5, EventKind::MerkleTreeInsertion), 90);
        let baselines = fresh_baseline_write_order(&caught_up, 5)
            .expect("baseline order")
            .expect("both baselines");
        assert_eq!(
            baselines,
            [
                (EventKind::MerkleTreeInsertion, 90),
                (EventKind::Dispatch, 100),
            ]
        );
        source
            .store_cursor(baselines[0].0, baselines[0].1)
            .expect("store lower fresh baseline");

        let interrupted_plan = replay_plan(&sources);
        assert_eq!(
            interrupted_plan.source(5).expect("source plan").floor,
            Some(90)
        );
        source
            .store_cursor(baselines[1].0, baselines[1].1)
            .expect("store higher fresh baseline");
        assert!(source_caught_up(false, &caught_up, &state, 5)
            .expect_err("unequal fresh baselines must reconnect")
            .to_string()
            .contains("Fresh scraper caught-up baselines differ"));

        let reconnect_plan = replay_plan(&sources);
        let source_plan = reconnect_plan.source(5).expect("source plan");
        assert_eq!(source_plan.floor, Some(90));
        assert_eq!(source_plan.correlation_next, Some(90));
        assert!(reconnect_plan
            .correlation_required(5)
            .expect("correlation requirement"));
        let request: serde_json::Value = serde_json::from_str(
            &subscription(&sources, &reconnect_plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");
        assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "89");
        assert_eq!(request["streams"][1]["cursors"][0]["afterSequence"], "89");
    }

    #[test]
    fn fresh_equal_baselines_preserve_readiness() {
        let sources = sources();
        let source = &sources[&5];
        let plan = replay_plan(&sources);
        let mut state = replay_state(&plan);
        state
            .set_baseline(5, EventKind::Dispatch, 100)
            .expect("set fresh dispatch baseline");
        state
            .set_baseline(5, EventKind::MerkleTreeInsertion, 100)
            .expect("set fresh Merkle baseline");
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), 100),
            ((5, EventKind::MerkleTreeInsertion), 100),
        ]);
        let baselines = fresh_baseline_write_order(&caught_up, 5)
            .expect("baseline order")
            .expect("both baselines");
        for (kind, sequence) in baselines {
            source
                .store_cursor(kind, sequence)
                .expect("store equal fresh baseline");
        }

        assert!(source_caught_up(false, &caught_up, &state, 5).expect("readiness check"));
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            Some(100)
        );
        assert_eq!(
            source
                .cursor(EventKind::MerkleTreeInsertion)
                .expect("Merkle cursor"),
            Some(100)
        );
    }

    #[test]
    fn fresh_negative_lower_baseline_persists_neither_tip() {
        let sources = sources();
        let source = &sources[&5];
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), 100),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);

        assert_eq!(
            fresh_baseline_write_order(&caught_up, 5).expect("baseline order"),
            None
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );
        assert_eq!(
            source
                .cursor(EventKind::MerkleTreeInsertion)
                .expect("Merkle cursor"),
            None
        );
        assert!(
            source_caught_up(false, &caught_up, &StreamState::default(), 5)
                .expect_err("negative unequal fresh baselines must reconnect")
                .to_string()
                .contains("Fresh scraper caught-up baselines differ")
        );
    }

    #[test]
    fn staged_parity_does_not_cross_unequal_fresh_markers() {
        let sources = sources();
        let source = &sources[&5];
        let plan = replay_plan(&sources);
        let mut state = replay_state(&plan);
        let mut staged = StagedParity::default();
        let mut caught_up = HashMap::from([((5, EventKind::Dispatch), 100)]);
        state
            .set_baseline(5, EventKind::Dispatch, 100)
            .expect("set dispatch marker");
        staged
            .push(
                5,
                state
                    .validate(
                        event(DISPATCH_EVENT_TYPE, 101, dispatch_data(101, b"one-oh-one")),
                        &sources,
                    )
                    .expect("stage dispatch after first marker"),
            )
            .expect("stage parity");
        assert!(staged
            .drain_ready(&plan, &caught_up, &state, 5)
            .expect("read staged frontier")
            .is_empty());

        state
            .set_baseline(5, EventKind::MerkleTreeInsertion, 90)
            .expect("set delayed Merkle marker");
        caught_up.insert((5, EventKind::MerkleTreeInsertion), 90);
        assert!(staged
            .drain_ready(&plan, &caught_up, &state, 5)
            .expect("unequal markers do not admit parity")
            .is_empty());
        assert_eq!(staged.len, 1);
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );

        let baselines = fresh_baseline_write_order(&caught_up, 5)
            .expect("baseline order")
            .expect("both positive baselines");
        source
            .store_cursor(baselines[0].0, baselines[0].1)
            .expect("persist lower baseline before reconnect");
        assert_eq!(
            replay_plan(&sources).source(5).expect("source plan").floor,
            Some(90)
        );
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
            assert_eq!(
                source.correlation_cursor().expect("correlation cursor"),
                None
            );

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
                (EventKind::MerkleTreeInsertion, 0),
            ]
        );
        assert_eq!(staged.len, 1, "dispatch one waits for Merkle one");

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
                .expect("drain next complete pair")
                .into_iter()
                .map(|event| (event.kind, event.sequence))
                .collect::<Vec<_>>(),
            vec![
                (EventKind::Dispatch, 1),
                (EventKind::MerkleTreeInsertion, 1),
            ]
        );
        assert_eq!(staged.len, 0);
    }

    #[test]
    fn fresh_empty_parity_advances_beyond_cross_stream_window() {
        let sources = sources();
        let source = &sources[&5];
        let plan = replay_plan(&sources);
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), -1),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);
        let mut state = replay_state(&plan);
        let mut staged = StagedParity::default();

        for sequence in 0..=CROSS_STREAM_WINDOW as u32 {
            let body = sequence.to_be_bytes();
            let message_id = dispatch_message(sequence, &body).id();
            let dispatch = state
                .validate(
                    event(
                        DISPATCH_EVENT_TYPE,
                        sequence,
                        dispatch_data(sequence, &body),
                    ),
                    &sources,
                )
                .expect("validate dispatch");
            staged.push(5, dispatch).expect("stage dispatch");
            assert!(staged
                .drain_ready(&plan, &caught_up, &state, 5)
                .expect("hold incomplete pair")
                .is_empty());

            let merkle = state
                .validate(
                    event(
                        MERKLE_EVENT_TYPE,
                        sequence,
                        merkle_data_for(sequence, H256::from_low_u64_be(2), message_id, 100),
                    ),
                    &sources,
                )
                .expect("validate Merkle insertion");
            staged.push(5, merkle).expect("stage Merkle insertion");
            let ready = staged
                .drain_ready(&plan, &caught_up, &state, 5)
                .expect("drain complete pair");
            assert_eq!(ready.len(), 2);

            if let Some(anchor) = state.initialize_correlation(5, sequence) {
                source
                    .store_correlation_cursor(anchor)
                    .expect("store correlation anchor");
            }
            let next = state
                .advance_correlation(5)
                .expect("advance correlation")
                .expect("complete pair advances correlation");
            source
                .store_correlation_cursor(next)
                .expect("store correlation frontier");
        }

        assert_eq!(staged.len, 0);
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            Some(CROSS_STREAM_WINDOW as u32 + 1)
        );
    }

    #[tokio::test]
    async fn fresh_empty_parity_anchors_replay_before_queue_admission() {
        let monitor = Arc::new(monitor(Arc::new(MockParityDatabase::new())));
        monitor.parity_read_disabled.store(true, Ordering::Release);
        let plan = replay_plan(&monitor.sources);
        monitor.reset_correlation_gate(1, &plan);
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), -1),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);
        let mut state = replay_state(&plan);
        let mut staged = StagedParity::default();

        for event in [
            event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, b"zero")),
            event(DISPATCH_EVENT_TYPE, 1, dispatch_data(1, b"one")),
        ] {
            let validated = state
                .validate(event, &monitor.sources)
                .expect("validate dispatch");
            staged.push(5, validated).expect("stage dispatch");
            monitor
                .flush_staged_parity(&mut state, &plan, &caught_up, 1, 5, &mut staged)
                .await
                .expect("unpaired dispatch remains staged");
        }
        assert_eq!(
            monitor.sources[&5]
                .correlation_cursor()
                .expect("correlation cursor"),
            None
        );

        let merkle_zero = state
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
                &monitor.sources,
            )
            .expect("validate Merkle zero");
        staged.push(5, merkle_zero).expect("stage Merkle zero");
        monitor
            .flush_staged_parity(&mut state, &plan, &caught_up, 1, 5, &mut staged)
            .await
            .expect("admit complete zero pair");

        assert_eq!(
            monitor.sources[&5]
                .correlation_cursor()
                .expect("correlation cursor"),
            Some(0),
            "the replay anchor is durable before parity workers can advance"
        );
        let gate = monitor.correlation_gate.lock();
        let gate_source = gate.sources.get(&5).expect("correlation gate source");
        assert_eq!(gate_source.durable_next, Some(0));
        assert_eq!(gate_source.cross_next, Some(1));
        drop(gate);
        assert_eq!(staged.len, 1, "dispatch one waits for Merkle one");
        for queue in monitor.parity_queues.values() {
            assert!(queue.lock().jobs.is_empty(), "parity reads are disabled");
        }
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
    fn fresh_empty_baselines_wait_for_first_complete_pair() {
        let sources = sources();
        let source = &sources[&5];
        let plan = replay_plan(&sources);
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), -1),
            ((5, EventKind::MerkleTreeInsertion), -1),
        ]);
        let mut skipped = replay_state(&plan);
        skipped
            .validate(
                event(DISPATCH_EVENT_TYPE, 5, dispatch_data(5, b"five")),
                &sources,
            )
            .expect("first nonzero dispatch event");
        assert!(
            sequenced_persistence_ready(&plan, &caught_up, &skipped, 5, 5)
                .expect_err("empty stream must start at zero")
                .to_string()
                .contains("expected 0")
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );

        let mut state = replay_state(&plan);
        state
            .set_baseline(5, EventKind::Dispatch, -1)
            .expect("set empty dispatch baseline");
        state
            .set_baseline(5, EventKind::MerkleTreeInsertion, -1)
            .expect("set empty Merkle baseline");
        assert!(source_caught_up(false, &caught_up, &state, 5).expect("readiness check"));

        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, b"zero")),
                &sources,
            )
            .expect("first dispatch event");
        assert!(
            !sequenced_persistence_ready(&plan, &caught_up, &state, 5, 0)
                .expect("persistence readiness")
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            None
        );
        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 1, dispatch_data(1, b"one")),
                &sources,
            )
            .expect("second dispatch event");
        assert!(
            !sequenced_persistence_ready(&plan, &caught_up, &state, 5, 1)
                .expect("persistence readiness")
        );
        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            None
        );

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
            .expect("first Merkle event");
        assert!(sequenced_persistence_ready(&plan, &caught_up, &state, 5, 0)
            .expect("persistence readiness"));
        let cursors = sequenced_cursor_write_order(&state, 5).expect("cursor write order");
        assert_eq!(
            cursors,
            [
                (EventKind::MerkleTreeInsertion, 0),
                (EventKind::Dispatch, 1),
            ]
        );
        for (kind, sequence) in cursors {
            source
                .store_cursor(kind, sequence)
                .expect("seed first complete pair cursor");
        }
        let correlation = state
            .initialize_correlation(5, 0)
            .expect("initialize correlation");
        source
            .store_correlation_cursor(correlation)
            .expect("store initial correlation");
        let correlation = state
            .advance_correlation(5)
            .expect("advance correlation")
            .expect("complete pair advances correlation");
        source
            .store_correlation_cursor(correlation)
            .expect("store advanced correlation");

        assert_eq!(
            source.cursor(EventKind::Dispatch).expect("dispatch cursor"),
            Some(1)
        );
        assert_eq!(
            source
                .cursor(EventKind::MerkleTreeInsertion)
                .expect("Merkle cursor"),
            Some(0)
        );
        assert_eq!(
            source.correlation_cursor().expect("correlation cursor"),
            Some(1)
        );
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
            .expect("next Merkle event");
        assert!(sequenced_persistence_ready(&plan, &caught_up, &state, 5, 1)
            .expect("initialized persistence readiness"));
        let reconnect_plan = replay_plan(&sources);
        assert_eq!(
            reconnect_plan.source(5).expect("source plan").floor,
            Some(0)
        );
        let request: serde_json::Value = serde_json::from_str(
            &subscription(&sources, &reconnect_plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");
        assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "-1");
        assert_eq!(request["streams"][1]["cursors"][0]["afterSequence"], "-1");
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
            assert!(
                !sequenced_persistence_ready(&plan, &caught_up, &state, 5, sequence)
                    .expect("persistence readiness")
            );
        }

        state
            .validate(
                event(DISPATCH_EVENT_TYPE, 0, dispatch_data(0, &[0])),
                &sources,
            )
            .expect("first dispatch event");
        assert!(sequenced_persistence_ready(&plan, &caught_up, &state, 5, 0)
            .expect("persistence readiness"));
        assert_eq!(
            sequenced_cursor_write_order(&state, 5).expect("cursor write order"),
            [
                (EventKind::Dispatch, 0),
                (EventKind::MerkleTreeInsertion, 1),
            ]
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
            assert!(!source_caught_up(false, &caught_up, &state, 5).expect("one empty marker"));
            caught_up.insert((5, peer), -1);
            assert!(source_caught_up(false, &caught_up, &state, 5)
                .expect_err("peer marker must reject staged nonzero start")
                .to_string()
                .contains("expected 0"));
        }
    }

    #[test]
    fn restart_replays_missing_peer_and_rechecks_late_correlation() {
        let sources = sources();
        let source = &sources[&5];
        source
            .store_cursor(EventKind::Dispatch, 7)
            .expect("store dispatch cursor");

        let plan = replay_plan(&sources);
        let message: serde_json::Value = serde_json::from_str(
            &subscription(&sources, &plan, &gas_payment_cursors(), true)
                .expect("subscription should serialize"),
        )
        .expect("subscription JSON");
        assert_eq!(message["streams"][0]["cursors"][0]["afterSequence"], "6");
        assert_eq!(message["streams"][1]["cursors"][0]["afterSequence"], "6");
        let streams = subscribed_streams(&sources, &plan);
        assert_eq!(
            streams[0].cursors.as_ref().expect("dispatch cursors")[0].after_sequence,
            Some("6".to_owned())
        );
        assert_eq!(
            streams[1].cursors.as_ref().expect("Merkle cursors")[0].after_sequence,
            Some("6".to_owned())
        );
        validate_subscription(&streams, &sources, &plan, &gas_payment_cursors(), true)
            .expect("subscription confirmation");

        let mut restarted = replay_state(&plan);
        restarted
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"seven")),
                &sources,
            )
            .expect("replay dispatch boundary");
        let caught_up = HashMap::from([
            ((5, EventKind::Dispatch), 7),
            ((5, EventKind::MerkleTreeInsertion), 6),
        ]);
        assert!(!source_caught_up(true, &caught_up, &restarted, 5).expect("readiness check"));

        restarted
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(
                        7,
                        H256::from_low_u64_be(2),
                        dispatch_message(7, b"seven").id(),
                        100,
                    ),
                ),
                &sources,
            )
            .expect("late Merkle correlation");
        let next = restarted
            .advance_correlation(5)
            .expect("advance correlation")
            .expect("late pair advances correlation");
        source
            .store_correlation_cursor(next)
            .expect("store correlation cursor");
        assert!(source_caught_up(true, &caught_up, &restarted, 5).expect("readiness check"));
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
        let mut handshake = HandshakeState::default();
        handshake.ready().expect("ready");
        let request: serde_json::Value = serde_json::from_str(
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
        source
            .store_correlation_cursor(200)
            .expect("advance correlation cursor");

        assert_eq!(request["streams"][0]["cursors"][0]["afterSequence"], "89");
        assert_eq!(request["streams"][1]["cursors"][0]["afterSequence"], "89");
        let streams = subscribed_streams(&sources, &plan);
        handshake
            .subscribed(&streams, &sources, &plan, &gas_payment_cursors(), true)
            .expect("subscription confirmation uses captured plan");
        handshake
            .event()
            .expect("caught-up accepted after confirmation");
        validate_caught_up_floor(&plan, 5, 90).expect("captured replay floor");
        assert!(validate_caught_up_floor(&plan, 5, 89).is_err());
    }

    #[test]
    fn parity_matches_do_not_combine_across_connection_generations() {
        let database = MockParityDatabase::new();
        let monitor = monitor(Arc::new(database));
        let source = &monitor.sources[&5];
        source
            .store_correlation_cursor(7)
            .expect("store replay anchor");
        let plan = SequencedReplayPlan::load(&monitor.sources).expect("replay plan");

        monitor.reset_correlation_gate(1, &plan);
        monitor.note_cross_stream_next(1, 5, 8);
        monitor
            .finish_parity_correlation(1, 5, EventKind::Dispatch, 7, ParityResult::Match.label())
            .expect("old generation dispatch match");
        assert_eq!(source.correlation_cursor().expect("cursor read"), Some(7));

        monitor.reset_correlation_gate(2, &plan);
        monitor.note_cross_stream_next(2, 5, 8);
        monitor
            .finish_parity_correlation(
                2,
                5,
                EventKind::MerkleTreeInsertion,
                7,
                ParityResult::Match.label(),
            )
            .expect("new generation Merkle match");
        monitor
            .finish_parity_correlation(1, 5, EventKind::Dispatch, 7, ParityResult::Match.label())
            .expect("late old generation completion ignored");
        assert_eq!(source.correlation_cursor().expect("cursor read"), Some(7));

        monitor
            .finish_parity_correlation(2, 5, EventKind::Dispatch, 7, ParityResult::Match.label())
            .expect("same generation dispatch match");
        assert_eq!(source.correlation_cursor().expect("cursor read"), Some(8));
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
            generation: 1,
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
                5,
                None,
                None,
                Some("21"),
                None,
                &sources,
            )
            .expect_err("caught-up boundary is required")
            .to_string()
            .contains("omitted legacy cursor boundary"));
        assert!(state
            .gas_payment_caught_up_cursor(
                &scraper_address(H256::from_low_u64_be(3)),
                5,
                Some("21"),
                None,
                Some("21"),
                None,
                &sources,
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
                5,
                Some("20"),
                None,
                Some("20"),
                None,
                &monitor.sources,
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
                accepted.gas_payment_cursor.expect("accepted event cursor"),
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
        let duplicate_cursor = duplicate.gas_payment_cursor.expect("duplicate cursor");
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
            .expect_err("unresolved payment must reject")
            .to_string()
            .contains("Invalid gas payment event payload"));
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
    fn correlates_dispatch_and_merkle_projection() {
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
            .expect("matching Merkle insertion should validate");
    }

    #[test]
    fn rejects_cross_stream_message_and_block_mismatches() {
        let fixture = fixture();
        let message = dispatch_message(7, b"payload");
        let mut wrong_message = StreamState::default();
        wrong_message
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &fixture.sources,
            )
            .expect("dispatch should validate");
        assert!(wrong_message
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), H256::from_low_u64_be(8), 100,),
                ),
                &fixture.sources,
            )
            .expect_err("message mismatch must reject")
            .to_string()
            .contains("message IDs differ"));

        let mut wrong_block = StreamState::default();
        wrong_block
            .validate(
                event(DISPATCH_EVENT_TYPE, 7, dispatch_data(7, b"payload")),
                &fixture.sources,
            )
            .expect("dispatch should validate");
        assert!(wrong_block
            .validate(
                event(
                    MERKLE_EVENT_TYPE,
                    7,
                    merkle_data_for(7, H256::from_low_u64_be(2), message.id(), 101),
                ),
                &fixture.sources,
            )
            .expect_err("block mismatch must reject")
            .to_string()
            .contains("block numbers differ"));
    }

    #[test]
    fn bounds_unmatched_cross_stream_projections() {
        let projection = ProtocolProjection {
            block_number: 100,
            message_id: H256::from_low_u64_be(7),
        };
        let mut state = CrossStreamState::default();
        for sequence in 0..CROSS_STREAM_WINDOW as u32 {
            state
                .validate(5, sequence, EventKind::Dispatch, projection)
                .expect("projection inside window");
        }
        assert_eq!(state.entries[&5].len(), CROSS_STREAM_WINDOW);
        assert!(state
            .validate(
                5,
                CROSS_STREAM_WINDOW as u32,
                EventKind::Dispatch,
                projection,
            )
            .expect_err("unmatched projection must not be evicted")
            .to_string()
            .contains("skew exceeds"));

        state
            .validate(5, 0, EventKind::MerkleTreeInsertion, projection)
            .expect("oldest projection should complete");
        state
            .validate(
                5,
                CROSS_STREAM_WINDOW as u32,
                EventKind::Dispatch,
                projection,
            )
            .expect("completed oldest projection should be evicted");
        assert_eq!(state.entries[&5].len(), CROSS_STREAM_WINDOW);
        assert!(!state.entries[&5].contains_key(&0));
        assert!(state.entries[&5].contains_key(&(CROSS_STREAM_WINDOW as u32)));
    }

    #[test]
    fn enforces_subscription_handshake_order() {
        let mut handshake = HandshakeState::default();
        let sources = sources();
        let plan = replay_plan(&sources);
        let streams = subscribed_streams(&sources, &plan);
        let cursors = gas_payment_cursors();
        assert!(handshake.event().is_err());
        assert!(handshake
            .subscribed(&streams, &sources, &plan, &cursors, true)
            .is_err());
        handshake.ready().expect("ready");
        assert!(handshake.event().is_err());
        handshake
            .subscribed(&streams, &sources, &plan, &cursors, true)
            .expect("subscribed");
        handshake.event().expect("event after confirmation");
        assert!(handshake
            .subscribed(&streams, &sources, &plan, &cursors, true)
            .is_err());
        assert!(handshake.ready().is_err());
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

        let mut handshake = HandshakeState::default();
        handshake.ready().expect("ready");
        handshake
            .subscribed(&streams, &sources, &plan, &gas_payment_cursors(), true)
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
            let mut handshake = HandshakeState::default();
            handshake.ready().expect("ready");
            assert!(handshake
                .subscribed(&streams, &sources, &plan, &cursors, true)
                .is_err());
            assert!(!handshake.confirmed);
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
        let message: serde_json::Value = serde_json::from_str(
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
                        "streamCursorVersion": 1
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
    fn legacy_subscription_preserves_sequenced_streams() {
        let sources = sources();
        let plan = replay_plan(&sources);
        let message: serde_json::Value = serde_json::from_str(
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
    async fn legacy_ready_rejects_unsolicited_gas_messages() {
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
                .send(Message::Text(r#"{"type":"ready"}"#.to_owned()))
                .await
                .expect("send legacy ready");
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
    async fn quarantines_invalid_gas_payment_without_stopping_other_streams() {
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
            poison.data["interchain_gas_paymaster"] =
                serde_json::json!(format!("{:#x}", H256::from_low_u64_be(4)));
            let message = dispatch_message(7, b"payload");
            let messages = [
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
        assert!(!state.gas_payment_rows.contains_key(&5));
        let source = monitor.sources.get(&5).expect("source");
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
        assert!(state.cross_stream.entries[&5][&7].complete());
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
