use std::{
    ops::Add,
    sync::atomic::{AtomicBool, Ordering},
};

use async_trait::async_trait;
use eyre::{bail, Result};
use tracing::{debug, instrument, trace};

use hyperlane_core::{
    identifiers::UniqueIdentifier, BackwardCursorProgress, Decode, Encode, GasPaymentKey,
    HyperlaneBackwardCursorStore, HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage,
    HyperlaneSequenceAwareIndexerStoreReader, HyperlaneWatermarkedLogStore, Indexed,
    InterchainGasExpenditure, InterchainGasPayment, InterchainGasPaymentMeta, LogMeta,
    MerkleTreeInsertion, PendingOperationStatus, H256, H512,
};

use crate::db::{
    storage_types::{
        InterchainGasExpenditureData, InterchainGasPaymentData, PendingMessageRetryState,
    },
    HyperlaneDb,
};

use super::{DbError, TypedDB, DB};

// these keys MUST not be given multiple uses in case multiple agents are
// started with the same database and domain.

const MESSAGE_ID: &str = "message_id_";
const MESSAGE_DISPATCHED_BLOCK_NUMBER: &str = "message_dispatched_block_number_";
const MESSAGE: &str = "message_";
const NONCE_PROCESSED: &str = "nonce_processed_";
const GAS_PAYMENT_BY_SEQUENCE: &str = "gas_payment_by_sequence_";
const GAS_PAYMENT_BLOCK_BY_SEQUENCE: &str = "gas_payment_block_by_sequence_";
const HIGHEST_SEEN_MESSAGE_NONCE: &str = "highest_seen_message_nonce_";
const GAS_PAYMENT_FOR_MESSAGE_ID: &str = "gas_payment_sequence_for_message_id_v2_";
const GAS_PAYMENT_META_PROCESSED: &str = "gas_payment_meta_processed_v3_";
const GAS_EXPENDITURE_FOR_MESSAGE_ID: &str = "gas_expenditure_for_message_id_v2_";
const STATUS_BY_MESSAGE_ID: &str = "status_by_message_id_";
const PENDING_MESSAGE_RETRY_COUNT_FOR_MESSAGE_ID: &str =
    "pending_message_retry_count_for_message_id_";
const PENDING_MESSAGE_RETRY_STATE_FOR_MESSAGE_ID: &str =
    "pending_message_retry_state_for_message_id_v1_";
const PENDING_MESSAGE_BY_DESTINATION: &str = "pending_message_by_destination_v1_";
const PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE: &str =
    "pending_message_index_migration_complete_v1_";
const TERMINALLY_DROPPED_MESSAGE_BY_ID: &str = "terminally_dropped_message_by_id_v1_";
const MERKLE_TREE_INSERTION: &str = "merkle_tree_insertion_";
const MERKLE_LEAF_INDEX_BY_MESSAGE_ID: &str = "merkle_leaf_index_by_message_id_";
const MERKLE_TREE_INSERTION_BLOCK_NUMBER_BY_LEAF_INDEX: &str =
    "merkle_tree_insertion_block_number_by_leaf_index_";
const LATEST_INDEXED_GAS_PAYMENT_BLOCK: &str = "latest_indexed_gas_payment_block";
const PAYLOAD_UUIDS_BY_MESSAGE_ID: &str = "payload_uuids_by_message_id_";
const MESSAGE_DISPATCHED_TX_HASH_BY_MESSAGE_ID: &str = "message_dispatched_tx_hash_by_message_id_";
const MESSAGE_BACKWARD_CURSOR: &str = "message_backward_cursor_v2_";
const GAS_PAYMENT_BACKWARD_CURSOR: &str = "gas_payment_backward_cursor_v2_";
const MERKLE_TREE_INSERTION_BACKWARD_CURSOR: &str = "merkle_tree_insertion_backward_cursor_v2_";

/// Rocks DB result type
pub type DbResult<T> = std::result::Result<T, DbError>;

/// DB handle for storing data tied to a specific Mailbox.
#[derive(Debug, Clone)]
pub struct HyperlaneRocksDB(HyperlaneDomain, TypedDB);

impl std::ops::Deref for HyperlaneRocksDB {
    type Target = TypedDB;

    fn deref(&self) -> &Self::Target {
        &self.1
    }
}

impl AsRef<TypedDB> for HyperlaneRocksDB {
    fn as_ref(&self) -> &TypedDB {
        &self.1
    }
}

impl AsRef<DB> for HyperlaneRocksDB {
    fn as_ref(&self) -> &DB {
        self.1.as_ref()
    }
}

impl HyperlaneRocksDB {
    /// Instantiated new `HyperlaneRocksDB`
    pub fn new(domain: &HyperlaneDomain, db: DB) -> Self {
        Self(domain.clone(), TypedDB::new(domain, db))
    }

    /// Get the domain this database is scoped to
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.0
    }

    fn retrieve_backward_cursor_progress(
        &self,
        prefix: &str,
    ) -> Result<Vec<BackwardCursorProgress>> {
        Ok(self.retrieve_decodables_by_prefix(prefix)?)
    }

    fn store_backward_cursor_progress(
        &self,
        prefix: &str,
        progress: BackwardCursorProgress,
    ) -> Result<()> {
        Ok(self.store_keyed_encodable(prefix, &progress.sequence, &progress)?)
    }

    fn delete_backward_cursor_progress(&self, prefix: &str, sequence: u32) -> Result<()> {
        let mut batch = self.1.batch();
        batch.delete_keyed(prefix, &sequence);
        Ok(batch.commit()?)
    }

    /// Store a raw committed message. If message already exists, then do nothing.
    ///
    /// Keys --> Values:
    /// - `nonce` --> `id`
    /// - `id` --> `message`
    /// - `nonce` --> `dispatched block number`
    pub fn store_message(
        &self,
        message: &HyperlaneMessage,
        dispatched_block_number: u64,
    ) -> DbResult<bool> {
        if let Some(stored_message) = self.retrieve_message_by_nonce(message.nonce)? {
            trace!(hyp_message=?message, "Message already stored in db");
            self.try_update_max_seen_message_nonce(message.nonce)?;
            self.reconcile_pending_message_index(&stored_message)?;
            return Ok(false);
        }
        self.upsert_message(message, dispatched_block_number)?;
        Ok(true)
    }

    /// Store a raw committed message.
    ///
    /// Keys --> Values:
    /// - `nonce` --> `id`
    /// - `id` --> `message`
    /// - `nonce` --> `dispatched block number`
    pub fn upsert_message(
        &self,
        message: &HyperlaneMessage,
        dispatched_block_number: u64,
    ) -> DbResult<()> {
        let id = message.id();
        let previous = self.retrieve_message_by_nonce(message.nonce)?;
        let max_nonce = self
            .retrieve_highest_seen_message_nonce()?
            .unwrap_or_default()
            .max(message.nonce);
        debug!(hyp_message=?message,  "Storing new message in db",);

        let entries = [
            (MESSAGE.as_bytes().to_vec(), id.to_vec(), message.to_vec()),
            (
                MESSAGE_ID.as_bytes().to_vec(),
                message.nonce.to_vec(),
                id.to_vec(),
            ),
            (
                HIGHEST_SEEN_MESSAGE_NONCE.as_bytes().to_vec(),
                bool::default().to_vec(),
                max_nonce.to_vec(),
            ),
            (
                MESSAGE_DISPATCHED_BLOCK_NUMBER.as_bytes().to_vec(),
                message.nonce.to_vec(),
                dispatched_block_number.to_vec(),
            ),
            (
                Self::pending_message_destination_prefix(message.destination),
                message.nonce.to_vec(),
                id.to_vec(),
            ),
        ];
        let mut deletions = Vec::new();
        if let Some(previous) = previous.filter(|previous| previous.id() != id) {
            deletions.push((
                TERMINALLY_DROPPED_MESSAGE_BY_ID.as_bytes().to_vec(),
                previous.id().to_vec(),
            ));
            if previous.destination != message.destination {
                deletions.push((
                    Self::pending_message_destination_prefix(previous.destination),
                    previous.nonce.to_vec(),
                ));
            }
        }
        self.store_and_delete_batch(entries, deletions)?;
        Ok(())
    }

    fn pending_message_destination_prefix(destination: u32) -> Vec<u8> {
        PENDING_MESSAGE_BY_DESTINATION
            .as_bytes()
            .iter()
            .chain(destination.to_be_bytes().iter())
            .copied()
            .collect()
    }

    /// Check that migration finished and subsequent writes maintained the index.
    /// Older binaries do not maintain this index; missing WAL also requires a rescan.
    pub fn pending_message_index_migration_complete(&self) -> DbResult<bool> {
        self.pending_message_index_migration_complete_with_cancellation(&AtomicBool::new(false))
    }

    /// Check migration completion while allowing a blocking WAL scan to stop on shutdown.
    pub fn pending_message_index_migration_complete_with_cancellation(
        &self,
        cancellation: &AtomicBool,
    ) -> DbResult<bool> {
        let Some(checkpoint) =
            self.retrieve_value_by_key::<_, u64>(PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE, &false)?
        else {
            return Ok(false);
        };
        // Capture before validation so concurrent writes remain covered next time.
        let sequence = self.latest_sequence_number();
        let validation = (|| {
            if checkpoint > sequence {
                return Ok(true);
            }
            // Standalone cleanup can race a replacement or crash before repair.
            // One WAL pass detects both legacy source writes and derived-index
            // deletions not paired with a canonical upsert/processed batch.
            self.has_unmarked_pending_index_updates_since(
                checkpoint,
                &[MESSAGE_ID.as_bytes(), NONCE_PROCESSED.as_bytes()],
                PENDING_MESSAGE_BY_DESTINATION.as_bytes(),
                cancellation,
            )
        })();
        if cancellation.load(Ordering::Relaxed) {
            return Err(DbError::Other(
                "Pending message index migration validation cancelled".to_string(),
            ));
        }
        match validation {
            Ok(false) => {}
            result => {
                debug!(
                    ?result,
                    checkpoint, "Pending message index cannot be certified; repeating migration"
                );
                self.store_and_delete_batch(
                    std::iter::empty(),
                    [(
                        PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE.as_bytes().to_vec(),
                        false.to_vec(),
                    )],
                )?;
                return Ok(false);
            }
        }
        self.mark_pending_message_index_migration_complete(sequence)?;
        Ok(true)
    }

    /// Seal a finished migration using the sequence captured before it started.
    /// Keeping that conservative boundary also detects legacy writes during migration.
    pub fn mark_pending_message_index_migration_complete(&self, sequence: u64) -> DbResult<()> {
        self.store_value_by_key(PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE, &false, &sequence)
    }

    /// Add an unprocessed message to its destination range.
    pub fn store_pending_message_index(&self, message: &HyperlaneMessage) -> DbResult<()> {
        self.store_value_by_key(
            Self::pending_message_destination_prefix(message.destination),
            &message.nonce,
            &message.id(),
        )
    }

    /// Remove a message from its destination range.
    pub fn delete_pending_message_index(&self, message: &HyperlaneMessage) -> DbResult<()> {
        self.store_and_delete_batch(
            std::iter::empty(),
            [
                (
                    Self::pending_message_destination_prefix(message.destination),
                    message.nonce.to_vec(),
                ),
                (
                    TERMINALLY_DROPPED_MESSAGE_BY_ID.as_bytes().to_vec(),
                    message.id().to_vec(),
                ),
            ],
        )
    }

    /// Remove a destination range entry when the message value is unavailable.
    pub fn delete_pending_message_index_by_nonce(
        &self,
        destination: u32,
        nonce: u32,
    ) -> DbResult<()> {
        self.store_and_delete_batch(
            std::iter::empty(),
            [(
                Self::pending_message_destination_prefix(destination),
                nonce.to_vec(),
            )],
        )
    }

    /// Persist that a message reached a terminal relayer outcome.
    /// Cleared when the message is processed or replaced at the same nonce.
    pub fn store_terminally_dropped_message(&self, message_id: &H256) -> DbResult<()> {
        self.store_value_by_key(TERMINALLY_DROPPED_MESSAGE_BY_ID, message_id, &true)
    }

    /// Return whether a message reached a terminal relayer outcome.
    pub fn retrieve_terminally_dropped_message(&self, message_id: &H256) -> DbResult<bool> {
        Ok(self
            .retrieve_value_by_key::<_, bool>(TERMINALLY_DROPPED_MESSAGE_BY_ID, message_id)?
            .unwrap_or(false))
    }

    /// Restore or remove an index entry according to the processed marker.
    pub fn reconcile_pending_message_index(&self, message: &HyperlaneMessage) -> DbResult<()> {
        let existing =
            self.retrieve_pending_message_at_or_after(message.destination, message.nonce)?;
        let existing = existing.filter(|(nonce, _)| *nonce == message.nonce);
        if self
            .retrieve_processed_by_nonce(&message.nonce)?
            .unwrap_or(false)
        {
            if existing.is_some() {
                self.delete_pending_message_index(message)?;
            }
        } else if existing != Some((message.nonce, message.id())) {
            self.store_pending_message_index(message)?;
        }
        Ok(())
    }

    /// Retrieve the first destination entry at or after `nonce`.
    pub fn retrieve_pending_message_at_or_after(
        &self,
        destination: u32,
        nonce: u32,
    ) -> DbResult<Option<(u32, H256)>> {
        self.retrieve_pending_message_from(destination, nonce, true)
    }

    /// Retrieve the first destination entry at or before `nonce`.
    pub fn retrieve_pending_message_at_or_before(
        &self,
        destination: u32,
        nonce: u32,
    ) -> DbResult<Option<(u32, H256)>> {
        self.retrieve_pending_message_from(destination, nonce, false)
    }

    fn retrieve_pending_message_from(
        &self,
        destination: u32,
        nonce: u32,
        forward: bool,
    ) -> DbResult<Option<(u32, H256)>> {
        let prefix = Self::pending_message_destination_prefix(destination);
        let entry = if forward {
            self.retrieve_by_prefix_at_or_after(&prefix, nonce.to_be_bytes())?
        } else {
            self.retrieve_by_prefix_at_or_before(&prefix, nonce.to_be_bytes())?
        };
        let Some((nonce, message_id)) = entry else {
            return Ok(None);
        };
        let nonce: [u8; 4] = nonce.try_into().map_err(|nonce: Vec<u8>| {
            DbError::Other(format!("Invalid pending message index key: {nonce:?}"))
        })?;
        Ok(Some((u32::from_be_bytes(nonce), message_id)))
    }

    /// Retrieve a message by its nonce
    pub fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>> {
        let id = self.retrieve_message_id_by_nonce(&nonce)?;
        match id {
            None => Ok(None),
            Some(id) => self.retrieve_message_by_id(&id),
        }
    }

    /// Retrieve the greatest nonce represented by the canonical nonce-to-ID map.
    pub fn retrieve_highest_message_nonce(&self) -> DbResult<Option<u32>> {
        // A message hash beginning with `id_` also matches MESSAGE_ID, but has
        // a 29-byte suffix instead of a four-byte nonce. Filter before decoding.
        Ok(self
            .retrieve_last_key_by_prefix(MESSAGE_ID)?
            .map(u32::from_be_bytes))
    }

    /// Update the nonce of the highest processed message we're aware of
    pub fn try_update_max_seen_message_nonce(&self, nonce: u32) -> DbResult<()> {
        let current_max = self
            .retrieve_highest_seen_message_nonce()?
            .unwrap_or_default();
        if nonce >= current_max {
            self.store_highest_seen_message_nonce_number(&nonce)?;
        }
        Ok(())
    }

    /// If the provided gas payment, identified by its metadata, has not been
    /// processed, processes the gas payment and records it as processed.
    /// Returns whether the gas payment was processed for the first time.
    pub fn process_indexed_gas_payment(
        &self,
        indexed_payment: Indexed<InterchainGasPayment>,
        log_meta: &LogMeta,
    ) -> DbResult<bool> {
        let payment = *(indexed_payment.inner());
        let gas_processing_successful = self.process_gas_payment(payment, log_meta)?;

        // only store the payment and return early if there's no sequence
        let Some(gas_payment_sequence) = indexed_payment.sequence else {
            return Ok(gas_processing_successful);
        };
        // otherwise store the indexing decorator as well
        if let Ok(Some(_)) = self.retrieve_gas_payment_by_sequence(&gas_payment_sequence) {
            trace!(
                ?indexed_payment,
                ?log_meta,
                "Attempted to process an already-processed indexed gas payment"
            );
            // Return false to indicate the gas payment was already processed
            return Ok(false);
        }

        self.store_gas_payment_by_sequence(&gas_payment_sequence, indexed_payment.inner())?;
        self.store_gas_payment_block_by_sequence(&gas_payment_sequence, &log_meta.block_number)?;

        Ok(gas_processing_successful)
    }

    /// If the provided gas payment, identified by its metadata, has not been
    /// processed, processes the gas payment and records it as processed.
    /// Returns whether the gas payment was processed for the first time.
    pub fn process_gas_payment(
        &self,
        payment: InterchainGasPayment,
        log_meta: &LogMeta,
    ) -> DbResult<bool> {
        let payment_meta = log_meta.into();
        // If the gas payment has already been processed, do nothing
        if self
            .retrieve_processed_by_gas_payment_meta(&payment_meta)?
            .unwrap_or(false)
        {
            trace!(
                ?payment,
                ?log_meta,
                "Attempted to process an already-processed gas payment"
            );
            // Return false to indicate the gas payment was already processed
            return Ok(false);
        }
        // Set the gas payment as processed
        self.store_processed_by_gas_payment_meta(&payment_meta, &true)?;

        // Update the total gas payment for the message to include the payment
        self.update_gas_payment_by_gas_payment_key(payment)?;

        // Return true to indicate the gas payment was processed for the first time
        Ok(true)
    }

    /// Store the merkle tree insertion event, and also store a mapping from message_id to leaf_index
    pub fn process_tree_insertion(
        &self,
        insertion: &MerkleTreeInsertion,
        insertion_block_number: u64,
    ) -> DbResult<bool> {
        if let Ok(Some(_)) = self.retrieve_merkle_tree_insertion_by_leaf_index(&insertion.index()) {
            debug!(insertion=?insertion, "Tree insertion already stored in db");
            return Ok(false);
        }
        self.store_tree_insertion(insertion, insertion_block_number)
    }

    /// Store the merkle tree insertion event, and also store a mapping from message_id to leaf_index.
    /// Overwrites existing insertions
    pub fn store_tree_insertion(
        &self,
        insertion: &MerkleTreeInsertion,
        insertion_block_number: u64,
    ) -> DbResult<bool> {
        if let Some(existing) =
            self.retrieve_merkle_tree_insertion_by_leaf_index(&insertion.index())?
        {
            if existing.message_id() != insertion.message_id() {
                self.delete_merkle_leaf_index_by_message_id(&existing.message_id())?;
            }
        }
        // even if double insertions are ok, store the leaf by `leaf_index` (guaranteed to be unique)
        // rather than by `message_id` (not guaranteed to be recurring), so that leaves can be retrieved
        // based on insertion order.
        self.store_merkle_tree_insertion_by_leaf_index(&insertion.index(), insertion)?;

        self.store_merkle_leaf_index_by_message_id(&insertion.message_id(), &insertion.index())?;

        self.store_merkle_tree_insertion_block_number_by_leaf_index(
            &insertion.index(),
            &insertion_block_number,
        )?;
        // Return true to indicate the tree insertion was processed
        Ok(true)
    }

    fn delete_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<()> {
        self.delete_encodable(MERKLE_LEAF_INDEX_BY_MESSAGE_ID, message_id.to_vec())
    }

    /// Processes the gas expenditure and store the total expenditure for the
    /// message.
    pub fn process_gas_expenditure(&self, expenditure: InterchainGasExpenditure) -> DbResult<()> {
        // Update the total gas expenditure for the message to include the payment
        self.update_gas_expenditure_by_message_id(expenditure)
    }

    /// Update the total gas payment for a message to include gas_payment
    fn update_gas_payment_by_gas_payment_key(&self, event: InterchainGasPayment) -> DbResult<()> {
        let gas_payment_key = event.into();
        let existing_payment =
            match self.retrieve_gas_payment_by_gas_payment_key(gas_payment_key)? {
                Some(payment) => payment,
                None => InterchainGasPayment::from_gas_payment_key(gas_payment_key),
            };
        let total = existing_payment.add(event);

        debug!(?event, new_total_gas_payment=?total, "Storing gas payment");
        self.store_interchain_gas_payment_data_by_gas_payment_key(&gas_payment_key, &total.into())?;

        Ok(())
    }

    /// Update the total gas spent for a message
    fn update_gas_expenditure_by_message_id(
        &self,
        event: InterchainGasExpenditure,
    ) -> DbResult<()> {
        let existing_expenditure = self.retrieve_gas_expenditure_by_message_id(event.message_id)?;
        let total = existing_expenditure.add(event);

        debug!(?event, new_total_gas_expenditure=?total, "Storing gas expenditure");
        self.store_interchain_gas_expenditure_data_by_message_id(
            &total.message_id,
            &InterchainGasExpenditureData {
                tokens_used: total.tokens_used,
                gas_used: total.gas_used,
            },
        )?;
        Ok(())
    }

    /// Retrieve the total gas payment for a message
    pub fn retrieve_gas_payment_by_gas_payment_key(
        &self,
        gas_payment_key: GasPaymentKey,
    ) -> DbResult<Option<InterchainGasPayment>> {
        Ok(self
            .retrieve_interchain_gas_payment_data_by_gas_payment_key(&gas_payment_key)?
            .map(|payment| {
                payment.complete(gas_payment_key.message_id, gas_payment_key.destination)
            }))
    }

    /// Retrieve the total gas payment for a message
    pub fn retrieve_gas_expenditure_by_message_id(
        &self,
        message_id: H256,
    ) -> DbResult<InterchainGasExpenditure> {
        Ok(self
            .retrieve_interchain_gas_expenditure_data_by_message_id(&message_id)?
            .unwrap_or_default()
            .complete(message_id))
    }
}

#[cfg(test)]
mod pending_index_tests {
    use std::sync::atomic::AtomicBool;

    use hyperlane_core::{HyperlaneDomain, HyperlaneMessage, H256};

    use super::*;
    use crate::db::rocks::test_utils::run_test_db;

    #[tokio::test]
    async fn highest_message_nonce_ignores_overlapping_message_keys() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            assert_eq!(db.retrieve_highest_message_nonce().unwrap(), None);

            // A valid row in the message table whose hash shares the nonce-map prefix.
            let mut hash = [0xfe; 32];
            hash[..3].copy_from_slice(b"id_");
            let hash = H256::from(hash);
            db.store_message_by_id(&hash, &message(7, 10)).unwrap();
            assert_eq!(db.retrieve_highest_message_nonce().unwrap(), None);

            // These sort below the overlapping row; the watermark must still be exact.
            for nonce in [0, 256, 2] {
                db.store_message_id_by_nonce(&nonce, &H256::zero()).unwrap();
            }
            assert_eq!(db.retrieve_highest_message_nonce().unwrap(), Some(256));
            assert!(db.retrieve_message_by_id(&hash).unwrap().is_some());

            db.store_message_id_by_nonce(&u32::MAX, &H256::zero())
                .unwrap();
            assert_eq!(db.retrieve_highest_message_nonce().unwrap(), Some(u32::MAX));
        })
        .await;
    }

    #[tokio::test]
    async fn highest_message_nonce_filters_key_width_before_value_decode() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            let other = HyperlaneRocksDB::new(
                &HyperlaneDomain::new_test_domain("other"),
                AsRef::<DB>::as_ref(&db).clone(),
            );
            other
                .store_message_id_by_nonce(&u32::MAX, &H256::zero())
                .unwrap();
            // Non-nonce keys may also have values that cannot decode as an H256.
            for key in [vec![0xfe], vec![0xfe; 29]] {
                db.store_encodable(MESSAGE_ID, key, &true).unwrap();
            }
            assert_eq!(db.retrieve_highest_message_nonce().unwrap(), None);
            db.store_message_id_by_nonce(&0, &H256::zero()).unwrap();
            assert_eq!(db.retrieve_highest_message_nonce().unwrap(), Some(0));
        })
        .await;
    }

    fn message(nonce: u32, destination: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            nonce,
            origin: 1,
            destination,
            sender: H256::zero(),
            recipient: H256::zero(),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn migration_seal_rejects_standalone_cleanup_after_replacement() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            for cleanup_during_migration in [false, true] {
                let original = message(2, 10);
                db.upsert_message(&original, 1).expect("original");
                let sequence = db.latest_sequence_number();
                if !cleanup_during_migration {
                    db.mark_pending_message_index_migration_complete(sequence)
                        .expect("seal");
                }
                // A loader's old terminal/missing-row observation can precede
                // an atomic replacement, then delete that replacement's entry.
                let mut replacement = original.clone();
                replacement.body = vec![1];
                db.upsert_message(&replacement, 2).expect("replacement");
                db.delete_pending_message_index_by_nonce(10, 2)
                    .expect("stale cleanup");
                if cleanup_during_migration {
                    db.mark_pending_message_index_migration_complete(sequence)
                        .expect("seal");
                }
                assert!(!db
                    .pending_message_index_migration_complete()
                    .expect("validate"));
            }
        })
        .await;
    }

    #[tokio::test]
    async fn migration_seal_decode_error_is_propagated() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            db.store_value_by_key(PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE, &false, &true)
                .expect("write malformed seal");
            assert!(db.pending_message_index_migration_complete().is_err());
        })
        .await;
    }

    #[tokio::test]
    async fn cancelled_migration_validation_preserves_seal() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            db.mark_pending_message_index_migration_complete(db.latest_sequence_number())
                .expect("seal");

            let cancellation = AtomicBool::new(true);
            assert!(db
                .pending_message_index_migration_complete_with_cancellation(&cancellation)
                .is_err());
            assert!(db.pending_message_index_migration_complete().unwrap());
        })
        .await;
    }

    #[tokio::test]
    async fn migration_seal_accepts_atomic_writes_and_refreshes() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            assert!(!db.pending_message_index_migration_complete().unwrap());
            db.mark_pending_message_index_migration_complete(db.latest_sequence_number())
                .unwrap();
            db.store_message(&message(100, 10), 1).unwrap();
            db.store_message(&message(2, 10), 1).unwrap();
            db.upsert_message(&message(2, 11), 2).unwrap();
            db.store_message_processed(&message(2, 11)).unwrap();
            db.store_dispatched_block_number_by_nonce(&100, &3).unwrap();
            db.store_dispatched_tx_hash_by_message_id(&message(100, 10).id(), &H512::zero())
                .unwrap();
            let sequence = db.latest_sequence_number();
            assert!(db.pending_message_index_migration_complete().unwrap());
            assert_eq!(
                db.retrieve_value_by_key::<_, u64>(
                    PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE,
                    &false
                )
                .unwrap(),
                Some(sequence)
            );
            assert!(db.pending_message_index_migration_complete().unwrap());
        })
        .await;
    }

    #[tokio::test]
    async fn migration_seal_rejects_legacy_low_nonce_insert_and_replacement() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            db.store_message(&message(100, 10), 1).unwrap();
            for legacy in [message(2, 10), message(2, 11)] {
                db.mark_pending_message_index_migration_complete(db.latest_sequence_number())
                    .unwrap();
                // Reproduce the older writer's separate message and nonce-map writes.
                db.store_message_by_id(&legacy.id(), &legacy).unwrap();
                db.store_message_id_by_nonce(&legacy.nonce, &legacy.id())
                    .unwrap();
                assert_eq!(db.retrieve_highest_seen_message_nonce().unwrap(), Some(100));
                assert!(!db.pending_message_index_migration_complete().unwrap());
                assert!(db
                    .retrieve_value_by_key::<_, u64>(
                        PENDING_MESSAGE_INDEX_MIGRATION_COMPLETE,
                        &false,
                    )
                    .unwrap()
                    .is_none());
                assert!(!db.pending_message_index_migration_complete().unwrap());
            }
        })
        .await;
    }

    #[tokio::test]
    async fn migration_seal_rejects_legacy_processed_reset() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            let message = message(2, 10);
            db.store_message(&message, 1).unwrap();
            db.store_message_processed(&message).unwrap();
            db.mark_pending_message_index_migration_complete(db.latest_sequence_number())
                .unwrap();
            db.store_processed_by_nonce(&message.nonce, &false).unwrap();
            assert!(!db.pending_message_index_migration_complete().unwrap());
        })
        .await;
    }

    #[tokio::test]
    async fn migration_seal_keeps_writes_during_migration_visible() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            let sequence = db.latest_sequence_number();
            db.store_message_id_by_nonce(&0, &message(0, 10).id())
                .unwrap();
            db.mark_pending_message_index_migration_complete(sequence)
                .unwrap();
            assert!(!db.pending_message_index_migration_complete().unwrap());
        })
        .await;
    }

    #[test]
    fn migration_seal_survives_reopen_with_retained_wal() {
        let dir = tempfile::tempdir().unwrap();
        let domain = HyperlaneDomain::new_test_domain("origin");
        {
            let db = HyperlaneRocksDB::new(
                &domain,
                DB::from_path_with_rollback_wal(dir.path()).unwrap(),
            );
            db.store_message(&message(0, 10), 1).unwrap();
            db.mark_pending_message_index_migration_complete(db.latest_sequence_number())
                .unwrap();
        }
        let db = HyperlaneRocksDB::new(
            &domain,
            DB::from_path_with_rollback_wal(dir.path()).unwrap(),
        );
        assert!(db.pending_message_index_migration_complete().unwrap());
    }

    #[test]
    fn migration_seal_rejects_missing_wal() {
        let dir = tempfile::tempdir().unwrap();
        let domain = HyperlaneDomain::new_test_domain("origin");
        let mut options = rocksdb::Options::default();
        options.create_if_missing(true);
        {
            let rocks = std::sync::Arc::new(rocksdb::DB::open(&options, dir.path()).unwrap());
            let db = HyperlaneRocksDB::new(&domain, DB(rocks.clone()));
            db.mark_pending_message_index_migration_complete(db.latest_sequence_number())
                .unwrap();
            db.store_message(&message(0, 10), 1).unwrap();
            rocks.flush().unwrap();
            db.store_message(&message(1, 10), 1).unwrap();
        }
        let db = HyperlaneRocksDB::new(
            &domain,
            rocksdb::DB::open(&options, dir.path()).unwrap().into(),
        );
        assert!(!db.pending_message_index_migration_complete().unwrap());
    }

    #[tokio::test]
    async fn destination_index_is_ordered_and_isolated() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            let first = message(0, 10);
            let later = message(2, 10);
            let other = message(1, 11);
            db.store_message(&later, 1).unwrap();
            db.store_message(&other, 1).unwrap();
            db.store_message(&first, 1).unwrap();

            assert_eq!(
                db.retrieve_pending_message_at_or_after(10, 0).unwrap(),
                Some((0, first.id()))
            );
            assert_eq!(
                db.retrieve_pending_message_at_or_after(10, 1).unwrap(),
                Some((2, later.id()))
            );
            assert_eq!(
                db.retrieve_pending_message_at_or_before(10, u32::MAX)
                    .unwrap(),
                Some((2, later.id()))
            );
            assert_eq!(
                db.retrieve_pending_message_at_or_after(11, 0).unwrap(),
                Some((1, other.id()))
            );
            assert_eq!(
                db.retrieve_pending_message_at_or_after(10, 3).unwrap(),
                None
            );
            assert_eq!(
                db.retrieve_pending_message_at_or_before(11, 0).unwrap(),
                None
            );
        })
        .await;
    }

    #[tokio::test]
    async fn upsert_moves_index_and_processing_removes_it() {
        run_test_db(|raw_db| async move {
            let db = HyperlaneRocksDB::new(&HyperlaneDomain::new_test_domain("origin"), raw_db);
            let old = message(7, 10);
            let moved = message(7, 11);
            db.upsert_message(&old, 1).unwrap();
            db.upsert_message(&moved, 2).unwrap();

            assert_eq!(
                db.retrieve_pending_message_at_or_after(10, 0).unwrap(),
                None
            );
            assert_eq!(
                db.retrieve_pending_message_at_or_after(11, 0).unwrap(),
                Some((7, moved.id()))
            );
            db.store_pending_message_index(&moved).unwrap();
            db.store_pending_message_index(&moved).unwrap();
            db.store_terminally_dropped_message(&moved.id()).unwrap();

            db.store_message_processed(&moved).unwrap();
            assert_eq!(db.retrieve_processed_by_nonce(&7).unwrap(), Some(true));
            assert!(!db.retrieve_terminally_dropped_message(&moved.id()).unwrap());
            assert_eq!(
                db.retrieve_pending_message_at_or_after(11, 0).unwrap(),
                None
            );
        })
        .await;
    }
}

#[async_trait]
impl HyperlaneLogStore<HyperlaneMessage> for HyperlaneRocksDB {
    /// Store a list of dispatched messages and their associated metadata.
    #[instrument(skip_all)]
    async fn store_logs(&self, messages: &[(Indexed<HyperlaneMessage>, LogMeta)]) -> Result<u32> {
        let mut stored: u32 = 0;
        for (message, meta) in messages {
            let stored_message = self.store_message(message.inner(), meta.block_number)?;
            if stored_message {
                stored = stored.saturating_add(1);
            }
            self.store_dispatched_tx_hash_by_message_id(
                &message.inner().id(),
                &meta.transaction_id,
            )?;
        }
        if stored > 0 {
            debug!(messages = stored, "Wrote new messages to database");
        }
        Ok(stored)
    }
}

async fn store_and_count_new<T: Copy>(
    store: &HyperlaneRocksDB,
    logs: &[(T, LogMeta)],
    log_type: &str,
    process: impl Fn(&HyperlaneRocksDB, T, &LogMeta) -> DbResult<bool>,
) -> Result<u32> {
    let mut new_logs: u32 = 0;
    for (log, meta) in logs {
        if process(store, *log, meta)? {
            new_logs = new_logs.saturating_add(1);
        }
    }
    if new_logs > 0 {
        debug!(new_logs, log_type, "Wrote new logs to database");
    }
    Ok(new_logs)
}

#[async_trait]
impl HyperlaneLogStore<InterchainGasPayment> for HyperlaneRocksDB {
    /// Store a list of interchain gas payments and their associated metadata.
    #[instrument(skip_all)]
    async fn store_logs(
        &self,
        payments: &[(Indexed<InterchainGasPayment>, LogMeta)],
    ) -> Result<u32> {
        store_and_count_new(
            self,
            payments,
            "gas payments",
            HyperlaneRocksDB::process_indexed_gas_payment,
        )
        .await
    }
}

#[async_trait]
impl HyperlaneLogStore<MerkleTreeInsertion> for HyperlaneRocksDB {
    /// Store every tree insertion event
    #[instrument(skip_all)]
    async fn store_logs(&self, leaves: &[(Indexed<MerkleTreeInsertion>, LogMeta)]) -> Result<u32> {
        let mut insertions: u32 = 0;
        for (insertion, meta) in leaves {
            if self.process_tree_insertion(insertion.inner(), meta.block_number)? {
                insertions = insertions.saturating_add(1);
            }
        }
        Ok(insertions)
    }
}

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<HyperlaneMessage> for HyperlaneRocksDB {
    /// Gets data by its sequence.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<HyperlaneMessage>> {
        let message = self.retrieve_message_by_nonce(sequence)?;
        Ok(message)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        let number = self.retrieve_dispatched_block_number_by_nonce(&sequence)?;
        Ok(number)
    }
}

macro_rules! impl_backward_cursor_store {
    ($event:ty, $key:expr) => {
        #[async_trait]
        impl HyperlaneBackwardCursorStore<$event> for HyperlaneRocksDB {
            async fn retrieve_backward_cursors(&self) -> Result<Vec<BackwardCursorProgress>> {
                self.retrieve_backward_cursor_progress($key)
            }

            async fn store_backward_cursor(&self, progress: BackwardCursorProgress) -> Result<()> {
                self.store_backward_cursor_progress($key, progress)
            }

            async fn reset_backward_cursor(&self, progress: BackwardCursorProgress) -> Result<()> {
                self.store_backward_cursor_progress($key, progress)
            }

            async fn delete_backward_cursor(&self, sequence: u32) -> Result<()> {
                self.delete_backward_cursor_progress($key, sequence)
            }
        }
    };
}

impl_backward_cursor_store!(HyperlaneMessage, MESSAGE_BACKWARD_CURSOR);
impl_backward_cursor_store!(InterchainGasPayment, GAS_PAYMENT_BACKWARD_CURSOR);
impl_backward_cursor_store!(MerkleTreeInsertion, MERKLE_TREE_INSERTION_BACKWARD_CURSOR);

#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<MerkleTreeInsertion> for HyperlaneRocksDB {
    /// Gets data by its sequence.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<MerkleTreeInsertion>> {
        let insertion = self.retrieve_merkle_tree_insertion_by_leaf_index(&sequence)?;
        Ok(insertion)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        let number = self.retrieve_merkle_tree_insertion_block_number_by_leaf_index(&sequence)?;
        Ok(number)
    }
}

// TODO: replace this blanket implementation to be able to do sequence-aware indexing
#[async_trait]
impl HyperlaneSequenceAwareIndexerStoreReader<InterchainGasPayment> for HyperlaneRocksDB {
    /// Gets data by its sequence.
    async fn retrieve_by_sequence(&self, sequence: u32) -> Result<Option<InterchainGasPayment>> {
        Ok(self.retrieve_gas_payment_by_sequence(&sequence)?)
    }

    /// Gets the block number at which the log occurred.
    async fn retrieve_log_block_number_by_sequence(&self, sequence: u32) -> Result<Option<u64>> {
        Ok(self.retrieve_gas_payment_block_by_sequence(&sequence)?)
    }
}

#[async_trait]
impl HyperlaneWatermarkedLogStore<InterchainGasPayment> for HyperlaneRocksDB {
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>> {
        let watermark = self.retrieve_decodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK)?;
        Ok(watermark)
    }

    /// Stores the block number high watermark
    async fn store_high_watermark(&self, block_number: u32) -> Result<()> {
        let result = self.store_encodable("", LATEST_INDEXED_GAS_PAYMENT_BLOCK, &block_number)?;
        Ok(result)
    }
}

// Keep this implementation for type compatibility with the `contract_syncs` sync builder
#[async_trait]
impl HyperlaneWatermarkedLogStore<HyperlaneMessage> for HyperlaneRocksDB {
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>> {
        bail!("Not implemented")
    }

    /// Stores the block number high watermark
    async fn store_high_watermark(&self, _block_number: u32) -> Result<()> {
        bail!("Not implemented")
    }
}

// Keep this implementation for type compatibility with the `contract_syncs` sync builder
#[async_trait]
impl HyperlaneWatermarkedLogStore<MerkleTreeInsertion> for HyperlaneRocksDB {
    /// Gets the block number high watermark
    async fn retrieve_high_watermark(&self) -> Result<Option<u32>> {
        bail!("Not implemented")
    }

    /// Stores the block number high watermark
    async fn store_high_watermark(&self, _block_number: u32) -> Result<()> {
        bail!("Not implemented")
    }
}

impl HyperlaneDb for HyperlaneRocksDB {
    fn retrieve_highest_seen_message_nonce(&self) -> DbResult<Option<u32>> {
        self.retrieve_highest_seen_message_nonce_number()
    }

    fn retrieve_highest_message_nonce(&self) -> DbResult<Option<u32>> {
        self.retrieve_highest_message_nonce()
    }

    fn retrieve_message_by_nonce(&self, nonce: u32) -> DbResult<Option<HyperlaneMessage>> {
        self.retrieve_message_by_nonce(nonce)
    }

    fn domain(&self) -> &HyperlaneDomain {
        self.domain()
    }

    fn store_message_id_by_nonce(&self, nonce: &u32, id: &H256) -> DbResult<()> {
        self.store_value_by_key(MESSAGE_ID, nonce, id)
    }

    fn retrieve_message_id_by_nonce(&self, nonce: &u32) -> DbResult<Option<H256>> {
        self.retrieve_value_by_key(MESSAGE_ID, nonce)
    }

    fn store_message_by_id(&self, id: &H256, message: &HyperlaneMessage) -> DbResult<()> {
        self.store_value_by_key(MESSAGE, id, message)
    }

    fn retrieve_message_by_id(&self, id: &H256) -> DbResult<Option<HyperlaneMessage>> {
        self.retrieve_value_by_key(MESSAGE, id)
    }

    fn store_dispatched_block_number_by_nonce(
        &self,
        nonce: &u32,
        block_number: &u64,
    ) -> DbResult<()> {
        self.store_value_by_key(MESSAGE_DISPATCHED_BLOCK_NUMBER, nonce, block_number)
    }

    fn retrieve_dispatched_block_number_by_nonce(&self, nonce: &u32) -> DbResult<Option<u64>> {
        self.retrieve_value_by_key(MESSAGE_DISPATCHED_BLOCK_NUMBER, nonce)
    }

    /// Store whether a message was processed by its nonce
    fn store_processed_by_nonce(&self, nonce: &u32, processed: &bool) -> DbResult<()> {
        self.store_value_by_key(NONCE_PROCESSED, nonce, processed)
    }

    fn store_message_processed(&self, message: &HyperlaneMessage) -> DbResult<()> {
        self.store_and_delete_batch(
            [(
                NONCE_PROCESSED.as_bytes().to_vec(),
                message.nonce.to_vec(),
                true.to_vec(),
            )],
            [
                (
                    Self::pending_message_destination_prefix(message.destination),
                    message.nonce.to_vec(),
                ),
                (
                    TERMINALLY_DROPPED_MESSAGE_BY_ID.as_bytes().to_vec(),
                    message.id().to_vec(),
                ),
            ],
        )
    }

    fn retrieve_processed_by_nonce(&self, nonce: &u32) -> DbResult<Option<bool>> {
        self.retrieve_value_by_key(NONCE_PROCESSED, nonce)
    }

    fn store_processed_by_gas_payment_meta(
        &self,
        meta: &InterchainGasPaymentMeta,
        processed: &bool,
    ) -> DbResult<()> {
        self.store_value_by_key(GAS_PAYMENT_META_PROCESSED, meta, processed)
    }

    fn retrieve_processed_by_gas_payment_meta(
        &self,
        meta: &InterchainGasPaymentMeta,
    ) -> DbResult<Option<bool>> {
        self.retrieve_value_by_key(GAS_PAYMENT_META_PROCESSED, meta)
    }

    fn store_interchain_gas_expenditure_data_by_message_id(
        &self,
        message_id: &H256,
        data: &InterchainGasExpenditureData,
    ) -> DbResult<()> {
        self.store_value_by_key(GAS_EXPENDITURE_FOR_MESSAGE_ID, message_id, data)
    }

    fn retrieve_interchain_gas_expenditure_data_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<InterchainGasExpenditureData>> {
        self.retrieve_value_by_key(GAS_EXPENDITURE_FOR_MESSAGE_ID, message_id)
    }

    /// Store the status of an operation by its message id
    fn store_status_by_message_id(
        &self,
        message_id: &H256,
        status: &PendingOperationStatus,
    ) -> DbResult<()> {
        self.store_value_by_key(STATUS_BY_MESSAGE_ID, message_id, status)
    }

    /// Retrieve the status of an operation by its message id
    fn retrieve_status_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<PendingOperationStatus>> {
        self.retrieve_value_by_key(STATUS_BY_MESSAGE_ID, message_id)
    }

    fn store_interchain_gas_payment_data_by_gas_payment_key(
        &self,
        key: &GasPaymentKey,
        data: &InterchainGasPaymentData,
    ) -> DbResult<()> {
        self.store_value_by_key(GAS_PAYMENT_FOR_MESSAGE_ID, key, data)
    }

    fn retrieve_interchain_gas_payment_data_by_gas_payment_key(
        &self,
        key: &GasPaymentKey,
    ) -> DbResult<Option<InterchainGasPaymentData>> {
        self.retrieve_value_by_key(GAS_PAYMENT_FOR_MESSAGE_ID, key)
    }

    fn store_gas_payment_by_sequence(
        &self,
        sequence: &u32,
        payment: &InterchainGasPayment,
    ) -> DbResult<()> {
        self.store_value_by_key(GAS_PAYMENT_BY_SEQUENCE, sequence, payment)
    }

    fn retrieve_gas_payment_by_sequence(
        &self,
        sequence: &u32,
    ) -> DbResult<Option<InterchainGasPayment>> {
        self.retrieve_value_by_key(GAS_PAYMENT_BY_SEQUENCE, sequence)
    }

    fn store_gas_payment_block_by_sequence(
        &self,
        sequence: &u32,
        block_number: &u64,
    ) -> DbResult<()> {
        self.store_value_by_key(GAS_PAYMENT_BLOCK_BY_SEQUENCE, sequence, block_number)
    }

    fn retrieve_gas_payment_block_by_sequence(&self, sequence: &u32) -> DbResult<Option<u64>> {
        self.retrieve_value_by_key(GAS_PAYMENT_BLOCK_BY_SEQUENCE, sequence)
    }

    /// Store the retry count for a pending message by its message id
    fn store_pending_message_retry_count_by_message_id(
        &self,
        message_id: &H256,
        count: &u32,
    ) -> DbResult<()> {
        self.store_value_by_key(
            PENDING_MESSAGE_RETRY_COUNT_FOR_MESSAGE_ID,
            message_id,
            count,
        )
    }

    /// Retrieve the retry count for a pending message by its message id
    fn retrieve_pending_message_retry_count_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<u32>> {
        self.retrieve_value_by_key(PENDING_MESSAGE_RETRY_COUNT_FOR_MESSAGE_ID, message_id)
    }

    fn store_pending_message_retry_state_by_message_id(
        &self,
        message_id: &H256,
        state: &PendingMessageRetryState,
    ) -> DbResult<()> {
        self.store_batch([
            (
                PENDING_MESSAGE_RETRY_STATE_FOR_MESSAGE_ID
                    .as_bytes()
                    .to_vec(),
                message_id.to_vec(),
                state.to_vec(),
            ),
            (
                PENDING_MESSAGE_RETRY_COUNT_FOR_MESSAGE_ID
                    .as_bytes()
                    .to_vec(),
                message_id.to_vec(),
                state.retry_count.to_vec(),
            ),
        ])
    }

    fn store_pending_message_retry_state_and_status_by_message_id(
        &self,
        message_id: &H256,
        state: &PendingMessageRetryState,
        status: &PendingOperationStatus,
    ) -> DbResult<()> {
        self.store_batch([
            (
                PENDING_MESSAGE_RETRY_STATE_FOR_MESSAGE_ID
                    .as_bytes()
                    .to_vec(),
                message_id.to_vec(),
                state.to_vec(),
            ),
            (
                PENDING_MESSAGE_RETRY_COUNT_FOR_MESSAGE_ID
                    .as_bytes()
                    .to_vec(),
                message_id.to_vec(),
                state.retry_count.to_vec(),
            ),
            (
                STATUS_BY_MESSAGE_ID.as_bytes().to_vec(),
                message_id.to_vec(),
                status.to_vec(),
            ),
        ])
    }

    fn retrieve_pending_message_retry_state_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<PendingMessageRetryState>> {
        self.retrieve_value_by_key(PENDING_MESSAGE_RETRY_STATE_FOR_MESSAGE_ID, message_id)
    }

    fn store_merkle_tree_insertion_by_leaf_index(
        &self,
        leaf_index: &u32,
        insertion: &MerkleTreeInsertion,
    ) -> DbResult<()> {
        self.store_value_by_key(MERKLE_TREE_INSERTION, leaf_index, insertion)
    }

    /// Retrieve the merkle tree insertion event by its leaf index
    fn retrieve_merkle_tree_insertion_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<MerkleTreeInsertion>> {
        self.retrieve_value_by_key(MERKLE_TREE_INSERTION, leaf_index)
    }

    fn store_merkle_leaf_index_by_message_id(
        &self,
        message_id: &H256,
        leaf_index: &u32,
    ) -> DbResult<()> {
        self.store_value_by_key(MERKLE_LEAF_INDEX_BY_MESSAGE_ID, message_id, leaf_index)
    }

    /// Retrieve the merkle leaf index of a message in the merkle tree
    fn retrieve_merkle_leaf_index_by_message_id(&self, message_id: &H256) -> DbResult<Option<u32>> {
        self.retrieve_value_by_key(MERKLE_LEAF_INDEX_BY_MESSAGE_ID, message_id)
    }

    fn store_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        leaf_index: &u32,
        block_number: &u64,
    ) -> DbResult<()> {
        self.store_value_by_key(
            MERKLE_TREE_INSERTION_BLOCK_NUMBER_BY_LEAF_INDEX,
            leaf_index,
            block_number,
        )
    }

    fn retrieve_merkle_tree_insertion_block_number_by_leaf_index(
        &self,
        leaf_index: &u32,
    ) -> DbResult<Option<u64>> {
        self.retrieve_value_by_key(MERKLE_TREE_INSERTION_BLOCK_NUMBER_BY_LEAF_INDEX, leaf_index)
    }

    fn store_highest_seen_message_nonce_number(&self, nonce: &u32) -> DbResult<()> {
        // There's no unit struct Encode/Decode impl, so just use `bool` and always use the `Default::default()` key
        self.store_value_by_key(HIGHEST_SEEN_MESSAGE_NONCE, &bool::default(), nonce)
    }

    /// Retrieve the nonce of the highest processed message we're aware of
    fn retrieve_highest_seen_message_nonce_number(&self) -> DbResult<Option<u32>> {
        // There's no unit struct Encode/Decode impl, so just use `bool` and always use the `Default::default()` key
        self.retrieve_value_by_key(HIGHEST_SEEN_MESSAGE_NONCE, &bool::default())
    }

    fn store_payload_uuids_by_message_id(
        &self,
        message_id: &H256,
        payload_uuids: Vec<UniqueIdentifier>,
    ) -> DbResult<()> {
        self.store_value_by_key(PAYLOAD_UUIDS_BY_MESSAGE_ID, message_id, &payload_uuids)
    }

    fn retrieve_payload_uuids_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<Vec<UniqueIdentifier>>> {
        self.retrieve_value_by_key(PAYLOAD_UUIDS_BY_MESSAGE_ID, message_id)
    }

    fn store_dispatched_tx_hash_by_message_id(
        &self,
        message_id: &H256,
        tx_hash: &H512,
    ) -> DbResult<()> {
        self.store_value_by_key(
            MESSAGE_DISPATCHED_TX_HASH_BY_MESSAGE_ID,
            message_id,
            tx_hash,
        )
    }

    fn retrieve_dispatched_tx_hash_by_message_id(
        &self,
        message_id: &H256,
    ) -> DbResult<Option<H512>> {
        self.retrieve_value_by_key(MESSAGE_DISPATCHED_TX_HASH_BY_MESSAGE_ID, message_id)
    }
}

impl HyperlaneRocksDB {
    /// Store a value by key
    pub fn store_value_by_key<K: Encode, V: Encode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
        value: &V,
    ) -> DbResult<()> {
        self.store_encodable(prefix, key.to_vec(), value)
    }

    /// Retrieve a value by key
    pub fn retrieve_value_by_key<K: Encode, V: Decode>(
        &self,
        prefix: impl AsRef<[u8]>,
        key: &K,
    ) -> DbResult<Option<V>> {
        self.retrieve_decodable(prefix, key.to_vec())
    }
}
