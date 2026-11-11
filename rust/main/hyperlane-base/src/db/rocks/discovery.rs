//! Reversible origin events. Execution receipts and gas expenditure are never rolled back.
use std::collections::{HashMap, HashSet};

use ethers::utils::keccak256;
use serde::{Deserialize, Serialize};

use super::*;
use crate::db::TypedDbBatch;
use hyperlane_core::{HyperlaneProtocolError, U256};

pub(super) const GAS_FINGERPRINT: &[u8] = b"discovery_gas_fingerprint_v1_";
const EVENTS: &[u8] = b"discovery_events_v1_";
const CHECKPOINT: &[u8] = b"discovery_checkpoint_v1_";
const GENERATION: &[u8] = b"discovery_generation_v1_";
const APPLIED: &[u8] = b"discovery_rollback_applied_v1_";
const RECOVERY: &[u8] = b"discovery_recovery_v1_";
pub(super) const PROCESSED_MESSAGE: &[u8] = b"discovery_processed_message_v1_";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
/// Last origin block whose discovery records are no longer provisional.
pub struct DiscoveryCheckpoint {
    /// Origin block height.
    pub height: u64,
    /// Canonical block identity at that height.
    pub hash: H256,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(super) enum Event {
    Dispatch {
        nonce: u32,
        id: H256,
        destination: u32,
    },
    Merkle {
        index: u32,
        id: H256,
    },
    Gas {
        id: H256,
        destination: u32,
        payment: U256,
        gas: U256,
        tx: H512,
        log: u64,
        sequence: Option<u32>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Record {
    block: DiscoveryCheckpoint,
    event: Event,
}

macro_rules! json_codec {
    ($ty:ty) => {
        impl Encode for $ty {
            fn write_to<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<usize> {
                let bytes = serde_json::to_vec(self).map_err(std::io::Error::other)?;
                writer.write_all(&bytes)?;
                Ok(bytes.len())
            }
        }
        impl Decode for $ty {
            fn read_from<R: std::io::Read>(
                reader: &mut R,
            ) -> std::result::Result<Self, HyperlaneProtocolError> {
                serde_json::from_reader(reader).map_err(|error| std::io::Error::other(error).into())
            }
        }
    };
}
json_codec!(Record);
json_codec!(DiscoveryCheckpoint);

impl Record {
    fn key(&self) -> H256 {
        keccak256(self.to_vec()).into()
    }
}

impl HyperlaneRocksDB {
    /// A confirmed-history conflict requires manual recovery, never journal rollback.
    pub fn confirmed_discovery_conflict(&self) -> DbResult<bool> {
        Ok(self
            .retrieve_value_by_key(INDEXED_EVENT_CONFLICT, &false)?
            .unwrap_or(false))
    }

    fn check_discovery_consistency(
        &self,
        matches: bool,
        kind: &'static str,
        height: u64,
    ) -> Result<()> {
        if !matches
            && self
                .discovery_checkpoint()?
                .is_some_and(|checkpoint| height <= checkpoint.height)
        {
            self.mark_indexed_event_conflict()?;
            return Err(ConflictingEvent(kind).into());
        }
        self.check_event_consistency(matches, kind)
    }

    /// Persist a terminal outcome only if its preparation still belongs to this history.
    pub fn store_terminal_discovery_message(&self, id: &H256, generation: u64) -> DbResult<()> {
        let _messages = self.4.lock();
        self.ensure_discovery_writable()?;
        if self.discovery_generation() != generation {
            return Err(DbError::Other(
                "Terminal outcome belongs to an orphaned origin".into(),
            ));
        }
        self.store_terminally_dropped_message(id)
    }

    /// Wake consumers when discovery changes.
    pub fn discovery_notification(&self) -> Arc<tokio::sync::Notify> {
        self.6.discovery_changed.clone()
    }

    /// Enable reversible discovery after establishing an RPC-verified stable boundary.
    /// Existing checkpoints must be verified by the caller before indexing resumes.
    pub fn enable_discovery(&self, checkpoint: DiscoveryCheckpoint) -> DbResult<()> {
        if self.discovery_checkpoint()?.is_none() {
            self.store_value_by_key(CHECKPOINT, &false, &checkpoint)?;
        }
        self.6
            .discovery_generation
            .store(self.stored_discovery_generation()?, Ordering::Release);
        self.6.discovery_enabled.store(true, Ordering::Release);
        Ok(())
    }

    /// Stable discovery boundary, distinct from message delivery status.
    pub fn discovery_checkpoint(&self) -> DbResult<Option<DiscoveryCheckpoint>> {
        self.retrieve_value_by_key(CHECKPOINT, &false)
    }

    /// Epoch used to invalidate prepared work and persisted submission retries.
    fn stored_discovery_generation(&self) -> DbResult<u64> {
        Ok(self.retrieve_value_by_key(GENERATION, &false)?.unwrap_or(0))
    }

    /// Whether a crash interrupted recovery or indexing requested reconciliation.
    pub fn discovery_recovery_pending(&self) -> DbResult<bool> {
        Ok(self
            .retrieve_value_by_key(RECOVERY, &false)?
            .unwrap_or(false))
    }

    pub(super) fn ensure_discovery_writable(&self) -> DbResult<()> {
        if self.6.discovery_enabled.load(Ordering::Acquire)
            && (self.discovery_recovery_pending()? || self.confirmed_discovery_conflict()?)
        {
            return Err(DbError::Other("Origin discovery is recovering".into()));
        }
        Ok(())
    }

    pub(super) fn record_discovery(
        &self,
        batch: &mut TypedDbBatch,
        block: DiscoveryCheckpoint,
        event: Event,
    ) -> DbResult<()> {
        if !self.6.discovery_enabled.load(Ordering::Acquire) {
            return Ok(());
        }
        self.ensure_discovery_writable()?;
        // Verify late backfill too: confirmation can race an older RPC range.
        if block.hash.is_zero() {
            return Err(DbError::Other("Provisional event has no block hash".into()));
        }
        let record = Record { block, event };
        batch.store_keyed_encodable(EVENTS, &record.key(), &record);
        Ok(())
    }

    pub(super) fn gas_fingerprint(payment: InterchainGasPayment, meta: &LogMeta) -> H256 {
        Record {
            block: DiscoveryCheckpoint {
                height: meta.block_number,
                hash: meta.block_hash,
            },
            event: Event::Gas {
                id: payment.message_id,
                destination: payment.destination,
                payment: payment.payment,
                gas: payment.gas_amount,
                tx: meta.transaction_id,
                log: meta.log_index.as_u64(),
                sequence: None,
            },
        }
        .key()
    }
    pub(super) fn check_discovery_gas(
        &self,
        payment: InterchainGasPayment,
        meta: &LogMeta,
    ) -> DbResult<()> {
        if !self.6.discovery_enabled.load(Ordering::Acquire) {
            return Ok(());
        }
        let key = InterchainGasPaymentMeta::from(meta);
        if self
            .retrieve_value_by_key::<_, H256>(GAS_FINGERPRINT, &key)?
            .is_some_and(|previous| previous != Self::gas_fingerprint(payment, meta))
        {
            if self
                .discovery_checkpoint()?
                .is_some_and(|checkpoint| meta.block_number <= checkpoint.height)
            {
                self.mark_indexed_event_conflict()?;
            } else {
                self.request_discovery_recovery()?;
            }
            return Err(DbError::Other("Conflicting gas payment receipt".into()));
        }
        Ok(())
    }

    /// Distinct provisional block identities to verify before advancing the boundary.
    pub fn discovery_blocks(&self) -> DbResult<Vec<DiscoveryCheckpoint>> {
        let records: Vec<Record> = self.retrieve_decodables_by_prefix(EVENTS)?;
        let mut blocks = records
            .into_iter()
            .map(|record| record.block)
            .collect::<Vec<_>>();
        blocks.sort_unstable_by_key(|block| (block.height, block.hash));
        blocks.dedup();
        Ok(blocks)
    }

    /// Promote only after the caller has verified all affected event block hashes.
    pub fn confirm_discovery(
        &self,
        checkpoint: DiscoveryCheckpoint,
        verified: &[DiscoveryCheckpoint],
    ) -> DbResult<()> {
        let _messages = self.4.lock();
        let _merkle = self.3.lock();
        let _gas = self.2.lock();
        self.ensure_discovery_writable()?;
        if self
            .discovery_checkpoint()?
            .is_some_and(|previous| previous.height > checkpoint.height)
        {
            return Err(DbError::Other(
                "Discovery confirmation boundary moved backwards".into(),
            ));
        }
        let verified: HashSet<_> = verified
            .iter()
            .map(|block| (block.height, block.hash))
            .collect();
        let records: Vec<Record> = self.retrieve_decodables_by_prefix(EVENTS)?;
        let mut batch = self.batch();
        for record in records
            .into_iter()
            .filter(|record| record.block.height <= checkpoint.height)
        {
            if !verified.contains(&(record.block.height, record.block.hash)) {
                return Err(DbError::Other(
                    "Discovery changed during verification; retry".into(),
                ));
            }
            batch.delete_keyed(EVENTS, &record.key());
        }
        batch.store_keyed_encodable(CHECKPOINT, &false, &checkpoint);
        batch.commit()
    }

    /// Stop consumers before recovery. Kept durably until DB and prover recovery finish.
    pub fn request_discovery_recovery(&self) -> DbResult<()> {
        let _admission = self.6.admission.lock();
        self.store_value_by_key(RECOVERY, &false, &true)?;
        if let Some(metric) = self.5.get() {
            metric.set(1);
        }
        self.6.changed.notify_waiters();
        Ok(())
    }

    /// Atomically discard provisional discovery, retaining execution receipts.
    /// Persist the rewind point until the caller has also recovered its prover.
    pub fn rollback_discovery(&self) -> DbResult<Option<u32>> {
        self.request_discovery_recovery()?;
        if self.confirmed_discovery_conflict()? {
            return Err(DbError::Other(
                "Confirmed origin history requires manual recovery".into(),
            ));
        }
        let _messages = self.4.lock();
        let _merkle = self.3.lock();
        let _gas = self.2.lock();
        if self.confirmed_discovery_conflict()? {
            return Err(DbError::Other(
                "Confirmed origin history requires manual recovery".into(),
            ));
        }
        if let Some(applied) = self.retrieve_value_by_key::<_, u32>(APPLIED, &false)? {
            return Ok((applied != u32::MAX).then_some(applied));
        }
        let checkpoint = self
            .discovery_checkpoint()?
            .ok_or_else(|| DbError::Other("Missing discovery checkpoint".into()))?;
        let records: Vec<Record> = self.retrieve_decodables_by_prefix(EVENTS)?;
        let mut batch = self.batch();
        let mut first_leaf = None;
        let mut removed_ids = HashSet::new();
        let mut removed_leaves = HashSet::new();
        let mut removed_nonces = HashSet::new();
        let mut gas_totals = HashMap::new();
        for record in records
            .into_iter()
            .filter(|record| record.block.height > checkpoint.height)
        {
            match record.event {
                Event::Dispatch {
                    nonce,
                    id,
                    destination,
                } => {
                    removed_nonces.insert(nonce);
                    batch.delete_keyed(MESSAGE_ID, &nonce);
                    batch.delete_keyed(MESSAGE, &id);
                    batch.delete_keyed(MESSAGE_DISPATCHED_BLOCK_NUMBER, &nonce);
                    batch.delete_keyed(MESSAGE_DISPATCHED_TX_HASH_BY_MESSAGE_ID, &id);
                    batch.delete_keyed(
                        Self::pending_message_destination_prefix(destination),
                        &nonce,
                    );
                    batch.delete_keyed(NONCE_PROCESSED, &nonce);
                    batch.delete_keyed(STATUS_BY_MESSAGE_ID, &id);
                    batch.delete_keyed(PENDING_MESSAGE_RETRY_COUNT_FOR_MESSAGE_ID, &id);
                    batch.delete_keyed(PENDING_MESSAGE_RETRY_STATE_FOR_MESSAGE_ID, &id);
                    batch.delete_keyed(TERMINALLY_DROPPED_MESSAGE_BY_ID, &id);
                }
                Event::Merkle { index, id } => {
                    removed_ids.insert(id);
                    removed_leaves.insert(index);
                    first_leaf = Some(first_leaf.map_or(index, |first: u32| first.min(index)));
                    batch.delete_keyed(MERKLE_TREE_INSERTION, &index);
                    batch.delete_keyed(MERKLE_TREE_INSERTION_BLOCK_NUMBER_BY_LEAF_INDEX, &index);
                    batch.delete_keyed(MERKLE_LEAF_INDEX_BY_MESSAGE_ID, &id);
                }
                Event::Gas {
                    id,
                    destination,
                    payment,
                    gas,
                    tx,
                    log,
                    sequence,
                } => {
                    let key = GasPaymentKey {
                        message_id: id,
                        destination,
                    };
                    let total = match gas_totals.entry((id, destination)) {
                        std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                        std::collections::hash_map::Entry::Vacant(entry) => entry.insert(
                            self.retrieve_gas_payment_by_gas_payment_key(key)?
                                .ok_or_else(|| {
                                    DbError::Other("Missing provisional gas total".into())
                                })?,
                        ),
                    };
                    total.payment = total.payment.checked_sub(payment).ok_or_else(|| {
                        DbError::Other("Provisional gas payment exceeds total".into())
                    })?;
                    total.gas_amount = total.gas_amount.checked_sub(gas).ok_or_else(|| {
                        DbError::Other("Provisional gas allowance exceeds total".into())
                    })?;
                    batch.delete_keyed(
                        GAS_FINGERPRINT,
                        &InterchainGasPaymentMeta {
                            transaction_id: tx,
                            log_index: log,
                        },
                    );
                    batch.delete_keyed(
                        GAS_PAYMENT_META_PROCESSED,
                        &InterchainGasPaymentMeta {
                            transaction_id: tx,
                            log_index: log,
                        },
                    );
                    if let Some(sequence) = sequence {
                        batch.delete_keyed(GAS_PAYMENT_BY_SEQUENCE, &sequence);
                        batch.delete_keyed(GAS_PAYMENT_BLOCK_BY_SEQUENCE, &sequence);
                    }
                }
            }
            batch.delete_keyed(EVENTS, &record.key());
        }
        for ((message_id, destination), total) in gas_totals {
            batch.store_keyed_encodable(
                GAS_PAYMENT_FOR_MESSAGE_ID,
                &GasPaymentKey {
                    message_id,
                    destination,
                },
                &InterchainGasPaymentData::from(total),
            );
        }
        // A message can have multiple insertions, including RPC backfill arriving late.
        if !removed_ids.is_empty() {
            self.visit_sequence_values(MERKLE_TREE_INSERTION, |leaf: MerkleTreeInsertion| {
                if removed_ids.contains(&leaf.message_id())
                    && !removed_leaves.contains(&leaf.index())
                {
                    batch.store_keyed_encodable(
                        MERKLE_LEAF_INDEX_BY_MESSAGE_ID,
                        &leaf.message_id(),
                        &leaf.index(),
                    );
                }
            })?;
        }
        for prefix in [
            MESSAGE_BACKWARD_CURSOR,
            GAS_PAYMENT_BACKWARD_CURSOR,
            MERKLE_TREE_INSERTION_BACKWARD_CURSOR,
        ] {
            batch.delete_prefix(prefix)?;
        }
        batch.store_encodable(
            LATEST_INDEXED_GAS_PAYMENT_BLOCK,
            b"",
            &u32::try_from(checkpoint.height).map_err(|error| DbError::Other(error.to_string()))?,
        );
        let mut highest = self.retrieve_highest_message_nonce()?;
        while highest.is_some_and(|nonce| removed_nonces.contains(&nonce)) {
            highest = highest.and_then(|nonce| nonce.checked_sub(1));
        }
        if let Some(nonce) = highest {
            batch.store_keyed_encodable(HIGHEST_SEEN_MESSAGE_NONCE, &false, &nonce);
        } else {
            batch.delete_keyed(HIGHEST_SEEN_MESSAGE_NONCE, &false);
        }
        let generation = self
            .stored_discovery_generation()?
            .checked_add(1)
            .ok_or_else(|| DbError::Other("Discovery generation exhausted".into()))?;
        batch.store_keyed_encodable(GENERATION, &false, &generation);
        batch.store_keyed_encodable(APPLIED, &false, &first_leaf.unwrap_or(u32::MAX));
        batch.commit()?;
        self.6
            .discovery_generation
            .store(generation, Ordering::Release);
        Ok(first_leaf)
    }

    /// Reopen the origin only after its in-memory prover has been rewound.
    pub fn finish_discovery_recovery(&self) -> DbResult<()> {
        let _admission = self.6.admission.lock();
        if self.confirmed_discovery_conflict()? {
            return Err(DbError::Other(
                "Confirmed origin history requires manual recovery".into(),
            ));
        }
        let mut batch = self.batch();
        batch.delete_keyed(RECOVERY, &false);
        batch.delete_keyed(APPLIED, &false);
        batch.commit()?;
        if let Some(metric) = self.5.get() {
            metric.set(0);
        }
        self.6.changed.notify_waiters();
        self.6.discovery_changed.notify_waiters();
        Ok(())
    }
}

impl HyperlaneRocksDB {
    /// Shared WebSocket/RPC dispatch ingestion, including provisional recovery data.
    pub fn store_indexed_dispatch(
        &self,
        message: &HyperlaneMessage,
        meta: &LogMeta,
    ) -> Result<bool> {
        self.store_indexed_dispatch_inner(message, meta, true)
    }

    pub(super) fn store_indexed_dispatch_inner(
        &self,
        message: &HyperlaneMessage,
        meta: &LogMeta,
        strict_tx: bool,
    ) -> Result<bool> {
        let _guard = self.4.lock();
        self.ensure_discovery_writable()?;
        let stored = self.retrieve_message_by_nonce(message.nonce)?;
        self.check_discovery_consistency(
            stored.as_ref().is_none_or(|old| old == message),
            "dispatch",
            meta.block_number,
        )?;
        self.check_discovery_consistency(
            self.retrieve_dispatched_block_number_by_nonce(&message.nonce)?
                .is_none_or(|old| old == meta.block_number),
            "dispatch block",
            meta.block_number,
        )?;
        let mut batch = self.batch();
        batch.store_keyed_encodable(
            MESSAGE_DISPATCHED_BLOCK_NUMBER,
            &message.nonce,
            &meta.block_number,
        );
        if stored.is_none() {
            batch.store_keyed_encodable(MESSAGE_ID, &message.nonce, &message.id());
            batch.store_keyed_encodable(MESSAGE, &message.id(), message);
            let highest = self
                .retrieve_highest_seen_message_nonce()?
                .unwrap_or(0)
                .max(message.nonce);
            batch.store_keyed_encodable(HIGHEST_SEEN_MESSAGE_NONCE, &false, &highest);
            if self
                .retrieve_value_by_key(PROCESSED_MESSAGE, &message.id())?
                .unwrap_or(false)
            {
                batch.store_keyed_encodable(NONCE_PROCESSED, &message.nonce, &true);
            } else {
                batch.delete_keyed(NONCE_PROCESSED, &message.nonce);
                batch.store_keyed_encodable(
                    Self::pending_message_destination_prefix(message.destination),
                    &message.nonce,
                    &message.id(),
                );
            }
            self.record_discovery(
                &mut batch,
                DiscoveryCheckpoint {
                    height: meta.block_number,
                    hash: meta.block_hash,
                },
                Event::Dispatch {
                    nonce: message.nonce,
                    id: message.id(),
                    destination: message.destination,
                },
            )?;
        }
        if !meta.transaction_id.is_zero() {
            let previous = self.retrieve_dispatched_tx_hash_by_message_id(&message.id())?;
            self.check_discovery_consistency(
                !strict_tx || previous.is_none_or(|tx| tx.is_zero() || tx == meta.transaction_id),
                "dispatch transaction",
                meta.block_number,
            )?;
            batch.store_keyed_encodable(
                MESSAGE_DISPATCHED_TX_HASH_BY_MESSAGE_ID,
                &message.id(),
                &meta.transaction_id,
            );
        }
        batch.commit()?;
        self.6.discovery_changed.notify_waiters();
        Ok(stored.is_none())
    }

    /// Shared WebSocket/RPC Merkle ingestion.
    pub fn store_indexed_merkle(
        &self,
        insertion: &MerkleTreeInsertion,
        meta: &LogMeta,
    ) -> Result<bool> {
        let _guard = self.3.lock();
        self.ensure_discovery_writable()?;
        let stored = self.retrieve_merkle_tree_insertion_by_leaf_index(&insertion.index())?;
        self.check_discovery_consistency(
            stored.is_none_or(|old| old == *insertion),
            "Merkle leaf",
            meta.block_number,
        )?;
        self.check_discovery_consistency(
            self.retrieve_merkle_tree_insertion_block_number_by_leaf_index(&insertion.index())?
                .is_none_or(|old| old == meta.block_number),
            "Merkle block",
            meta.block_number,
        )?;
        let previous = self.retrieve_merkle_leaf_index_by_message_id(&insertion.message_id())?;
        let mut batch = self.batch();
        batch.store_keyed_encodable(MERKLE_TREE_INSERTION, &insertion.index(), insertion);
        batch.store_keyed_encodable(
            MERKLE_TREE_INSERTION_BLOCK_NUMBER_BY_LEAF_INDEX,
            &insertion.index(),
            &meta.block_number,
        );
        if previous.is_none_or(|index| index < insertion.index()) {
            batch.store_keyed_encodable(
                MERKLE_LEAF_INDEX_BY_MESSAGE_ID,
                &insertion.message_id(),
                &insertion.index(),
            );
        }
        if stored.is_none() {
            self.record_discovery(
                &mut batch,
                DiscoveryCheckpoint {
                    height: meta.block_number,
                    hash: meta.block_hash,
                },
                Event::Merkle {
                    index: insertion.index(),
                    id: insertion.message_id(),
                },
            )?;
        }
        batch.commit()?;
        self.6.discovery_changed.notify_waiters();
        Ok(stored.is_none())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_utils::{run_test_db, setup_db};
    fn checkpoint(height: u64) -> DiscoveryCheckpoint {
        DiscoveryCheckpoint {
            height,
            hash: H256::from_low_u64_be(height),
        }
    }
    fn meta(height: u64, tx: u64) -> LogMeta {
        LogMeta {
            block_number: height,
            block_hash: checkpoint(height).hash,
            transaction_id: H512::from_low_u64_be(tx),
            ..Default::default()
        }
    }
    fn message(nonce: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            destination: 7,
            ..Default::default()
        }
    }
    fn payment(value: u64) -> InterchainGasPayment {
        InterchainGasPayment {
            message_id: message(1).id(),
            destination: 7,
            payment: value.into(),
            gas_amount: value.into(),
        }
    }

    #[tokio::test]
    async fn discovery_rollback_preserves_receipts_and_deduplicates_both_transports() {
        run_test_db(|raw| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("discovery"), raw);
            db.enable_discovery(checkpoint(10)).unwrap();
            db.store_indexed_dispatch(&message(0), &meta(10, 0))
                .unwrap();
            // Reindexing repairs block metadata missing from legacy rows.
            let mut batch = db.batch();
            batch.delete_keyed(MESSAGE_DISPATCHED_BLOCK_NUMBER, &0u32);
            batch.commit().unwrap();
            assert!(!db
                .store_indexed_dispatch(&message(0), &meta(10, 0))
                .unwrap());
            assert_eq!(
                db.retrieve_dispatched_block_number_by_nonce(&0).unwrap(),
                Some(10)
            );
            db.process_gas_payment(payment(3), &meta(10, 3)).unwrap();
            db.store_indexed_merkle(&MerkleTreeInsertion::new(0, message(0).id()), &meta(10, 0))
                .unwrap();
            db.confirm_discovery(checkpoint(10), &[checkpoint(10)])
                .unwrap();
            db.store_indexed_dispatch(&message(1), &meta(11, 1))
                .unwrap();
            assert!(!db
                .store_indexed_dispatch(&message(1), &meta(11, 1))
                .unwrap());
            db.store_indexed_merkle(&MerkleTreeInsertion::new(1, message(1).id()), &meta(11, 1))
                .unwrap();
            db.process_gas_payment(payment(5), &meta(11, 5)).unwrap();
            assert!(!db
                .process_indexed_gas_payment(Indexed::new(payment(5)), &meta(11, 5))
                .unwrap());
            db.process_gas_payment(payment(8), &meta(12, 8)).unwrap();
            db.store_interchain_gas_expenditure_data_by_message_id(
                &message(1).id(),
                &InterchainGasExpenditureData {
                    tokens_used: 2.into(),
                    gas_used: 1.into(),
                },
            )
            .unwrap();
            assert_eq!(db.rollback_discovery().unwrap(), Some(1));
            assert_eq!(db.rollback_discovery().unwrap(), Some(1));
            assert_eq!(db.discovery_generation(), 1);
            assert!(db.ensure_no_indexed_event_conflict().is_err());
            assert_eq!(
                db.retrieve_gas_payment_by_gas_payment_key(payment(0).into())
                    .unwrap()
                    .unwrap()
                    .payment,
                3.into()
            );
            assert!(db.retrieve_message_by_nonce(0).unwrap().is_some());
            assert!(db.retrieve_message_by_nonce(1).unwrap().is_none());
            assert_eq!(db.retrieve_highest_seen_message_nonce().unwrap(), Some(0));
            db.finish_discovery_recovery().unwrap();
            // An old in-flight receipt arrives before the replacement is indexed.
            db.store_message_processed(&message(1)).unwrap();
            let mut replacement = message(1);
            replacement.body = vec![99];
            db.store_indexed_dispatch(&replacement, &meta(12, 99))
                .unwrap();
            assert_ne!(db.retrieve_processed_by_nonce(&1).unwrap(), Some(true));
            db.store_message_processed(&message(1)).unwrap();
            assert_ne!(db.retrieve_processed_by_nonce(&1).unwrap(), Some(true));
            assert!(db
                .retrieve_pending_message_at_or_after(7, 1)
                .unwrap()
                .is_some());
            assert!(
                HyperlaneRocksDB::with_origin_generations(&[(&db, 0)], async {})
                    .await
                    .is_err()
            );
            assert!(
                HyperlaneRocksDB::with_origin_generations(&[(&db, 1)], async {})
                    .await
                    .is_ok()
            );
        })
        .await;
    }

    #[tokio::test]
    async fn discovery_recovery_preserves_confirmed_backfill_and_refuses_confirmed_conflicts() {
        run_test_db(|raw| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("boundary"), raw);
            db.enable_discovery(checkpoint(10)).unwrap();
            // A historical RPC range can finish after the boundary was promoted.
            db.store_indexed_dispatch(&message(0), &meta(9, 1)).unwrap();
            db.store_indexed_dispatch(&message(1), &meta(11, 2))
                .unwrap();
            db.rollback_discovery().unwrap();
            db.finish_discovery_recovery().unwrap();
            assert_eq!(db.retrieve_message_by_nonce(0).unwrap(), Some(message(0)));
            assert!(db.retrieve_message_by_nonce(1).unwrap().is_none());
            assert_eq!(db.discovery_blocks().unwrap(), vec![checkpoint(9)]);
            db.confirm_discovery(checkpoint(10), &[checkpoint(9)])
                .unwrap();
            let mut replacement = message(0);
            replacement.body = vec![1];
            assert!(db
                .store_indexed_dispatch(&replacement, &meta(9, 3))
                .is_err());
            assert!(db.confirmed_discovery_conflict().unwrap());
            assert!(db.rollback_discovery().is_err());
            assert!(db.finish_discovery_recovery().is_err());
            assert_eq!(db.retrieve_message_by_nonce(0).unwrap(), Some(message(0)));
            assert_eq!(db.discovery_generation(), 1);
        })
        .await;
    }

    #[tokio::test]
    async fn discovery_promotion_cannot_skip_late_rpc_backfill() {
        run_test_db(|raw| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("promotion"), raw);
            db.enable_discovery(checkpoint(10)).unwrap();
            db.store_indexed_merkle(&MerkleTreeInsertion::new(2, message(1).id()), &meta(12, 2))
                .unwrap();
            let verified = db.discovery_blocks().unwrap();
            db.store_indexed_merkle(&MerkleTreeInsertion::new(0, message(1).id()), &meta(9, 0))
                .unwrap();
            assert!(db.confirm_discovery(checkpoint(12), &verified).is_err());
            db.confirm_discovery(checkpoint(10), &[checkpoint(9)])
                .unwrap();
            assert_eq!(db.rollback_discovery().unwrap(), Some(2));
            assert_eq!(
                db.retrieve_merkle_leaf_index_by_message_id(&message(1).id())
                    .unwrap(),
                Some(0)
            );
        })
        .await;
    }

    #[test]
    fn discovery_crash_after_rollback_replays_the_prover_rewind() {
        let dir = tempfile::tempdir().unwrap();
        let domain = HyperlaneDomain::new_test_domain("restart");
        {
            let db =
                HyperlaneRocksDB::new(&domain, setup_db(dir.path().to_string_lossy().into_owned()));
            db.enable_discovery(checkpoint(10)).unwrap();
            db.store_indexed_merkle(&MerkleTreeInsertion::new(5, message(1).id()), &meta(11, 1))
                .unwrap();
            assert_eq!(db.rollback_discovery().unwrap(), Some(5));
        }
        let db =
            HyperlaneRocksDB::new(&domain, setup_db(dir.path().to_string_lossy().into_owned()));
        db.enable_discovery(checkpoint(10)).unwrap();
        assert!(db.discovery_recovery_pending().unwrap());
        assert_eq!(db.rollback_discovery().unwrap(), Some(5));
        assert_eq!(db.discovery_generation(), 1);
        db.finish_discovery_recovery().unwrap();
        assert!(db.ensure_no_indexed_event_conflict().is_ok());
    }

    #[tokio::test]
    async fn discovery_gas_payload_conflict_requests_recovery_without_credit() {
        run_test_db(|raw| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("gas"), raw);
            db.enable_discovery(checkpoint(10)).unwrap();
            db.process_gas_payment(payment(5), &meta(11, 5)).unwrap();
            assert!(db.process_gas_payment(payment(50), &meta(11, 5)).is_err());
            assert!(db.discovery_recovery_pending().unwrap());
            db.rollback_discovery().unwrap();
            db.finish_discovery_recovery().unwrap();
            assert!(db.process_gas_payment(payment(5), &meta(12, 5)).unwrap());
        })
        .await;
    }
}
