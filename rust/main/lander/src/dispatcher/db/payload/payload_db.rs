// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, LazyLock, Mutex},
};

use async_trait::async_trait;
use eyre::eyre;
use hyperlane_base::db::{DbError, DbResult, HyperlaneRocksDB};
use hyperlane_core::{identifiers::UniqueIdentifier, Decode, Encode, HyperlaneProtocolError};
use tracing::{debug, warn};

use crate::{
    payload::{self, FullPayload, PayloadStatus, PayloadUuid},
    transaction::TransactionUuid,
};

const PAYLOAD_BY_UUID_STORAGE_PREFIX: &str = "payload_by_uuid_";
const TRANSACTION_UUID_BY_PAYLOAD_UUID_STORAGE_PREFIX: &str = "transaction_uuid_by_payload_uuid_";
const PAYLOAD_INDEX_BY_UUID_STORAGE_PREFIX: &str = "payload_index_by_uuid_";
const PAYLOAD_UUID_BY_INDEX_STORAGE_PREFIX: &str = "payload_uuid_by_index_";
const HIGHEST_PAYLOAD_INDEX_STORAGE_PREFIX: &str = "highest_payload_index_";
const PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX: &str = "pending_payload_by_index_";
const PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX: &str = "pending_payload_index_checkpoint_";
const PENDING_PAYLOAD_INDEX_WRITE_MARKER_STORAGE_PREFIX: &str =
    "pending_payload_index_write_marker_";
static PAYLOAD_WRITE_LOCKS: LazyLock<Mutex<HashMap<u32, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn payload_write_lock(db: &HyperlaneRocksDB) -> DbResult<Arc<Mutex<()>>> {
    let mut locks = PAYLOAD_WRITE_LOCKS
        .lock()
        .map_err(|_| DbError::Other("Payload write-lock registry was poisoned".to_string()))?;
    Ok(locks
        .entry(db.domain().id())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}
#[async_trait]
pub trait PayloadDb: Send + Sync {
    /// Retrieve a payload by its unique ID
    async fn retrieve_payload_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<FullPayload>>;

    /// Store a payload by its unique ID
    async fn store_payload_by_uuid(&self, payload: &FullPayload) -> DbResult<()>;

    /// Retrieve a payload index by its unique ID
    async fn retrieve_payload_index_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<u32>>;

    /// Store a payload index by the payload's unique ID
    async fn store_payload_index_by_uuid(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()>;

    /// Retrieve a payload's unique ID by its index
    async fn retrieve_payload_uuid_by_index(&self, index: u32) -> DbResult<Option<PayloadUuid>>;

    /// Store a payload's unique ID by the payload's index
    async fn store_payload_uuid_by_index(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()>;

    /// Retrieve a payload by its index
    async fn retrieve_payload_by_index(&self, index: u32) -> DbResult<Option<FullPayload>> {
        let payload_uuid = self.retrieve_payload_uuid_by_index(index).await?;
        if let Some(payload_uuid) = payload_uuid {
            self.retrieve_payload_by_uuid(&payload_uuid).await
        } else {
            Ok(None)
        }
    }

    /// Store the highest payload index
    async fn store_highest_payload_index(&self, index: u32) -> DbResult<()>;

    /// Retrieve the highest payload index
    async fn retrieve_highest_payload_index(&self) -> DbResult<u32>;

    /// Retrieve payloads which still need transaction building.
    async fn retrieve_pending_payloads(&self) -> DbResult<Vec<FullPayload>>;

    /// RocksDB sequence through which the pending index was last validated.
    async fn pending_payload_index_checkpoint(&self) -> DbResult<Option<u64>>;

    /// Whether canonical payload writes after the checkpoint were made by a
    /// binary which did not atomically maintain the pending index.
    async fn pending_payload_index_requires_reconciliation(
        &self,
        checkpoint: u64,
    ) -> DbResult<bool>;

    /// Record that the pending index is consistent through the latest RocksDB
    /// sequence.
    async fn mark_pending_payload_index_reconciled(&self) -> DbResult<()>;

    /// Clear the pending index before a full reconciliation.
    async fn begin_pending_payload_index_reconciliation(&self) -> DbResult<()>;

    /// Reconcile a bounded inclusive range of historical payload indexes.
    async fn reconcile_pending_payloads(
        &self,
        first_index: u32,
        last_index: u32,
    ) -> DbResult<Vec<FullPayload>>;

    /// Set the status of a payload by its unique ID. Performs one read (to first fetch the full payload) and one write.
    async fn store_new_payload_status(
        &self,
        payload_uuid: &PayloadUuid,
        new_status: PayloadStatus,
    ) -> DbResult<()> {
        if let Some(mut payload) = self.retrieve_payload_by_uuid(payload_uuid).await? {
            payload.status = new_status;
            self.store_payload_by_uuid(&payload).await?;
        } else {
            return Err(DbError::Other(format!(
                "Payload with UUID {payload_uuid:?} not found"
            )));
        }
        Ok(())
    }

    async fn store_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()>;

    async fn retrieve_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<TransactionUuid>>;
}

#[async_trait]
impl PayloadDb for HyperlaneRocksDB {
    async fn retrieve_payload_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<FullPayload>> {
        self.retrieve_value_by_key(PAYLOAD_BY_UUID_STORAGE_PREFIX, payload_uuid)
    }

    async fn store_payload_by_uuid(&self, payload: &FullPayload) -> DbResult<()> {
        let write_lock = payload_write_lock(self)?;
        let _write_guard = write_lock
            .lock()
            .map_err(|_| DbError::Other("Payload database write lock was poisoned".to_string()))?;
        let mut batch = self.batch();

        let payload_index = if let Some(payload_index) = self
            .retrieve_value_by_key::<_, u32>(PAYLOAD_INDEX_BY_UUID_STORAGE_PREFIX, payload.uuid())?
        {
            debug!(
                payload_uuid = ?payload.uuid(),
                "Payload with UUID already exists, not updating index",
            );
            payload_index
        } else {
            let highest_index: u32 = self
                .retrieve_value_by_key(HIGHEST_PAYLOAD_INDEX_STORAGE_PREFIX, &bool::default())?
                .unwrap_or_default();
            let payload_index = highest_index.checked_add(1).ok_or_else(|| {
                DbError::Other("Highest payload index exhausted (u32::MAX)".into())
            })?;
            batch.store_keyed_encodable(
                HIGHEST_PAYLOAD_INDEX_STORAGE_PREFIX,
                &bool::default(),
                &payload_index,
            );
            batch.store_keyed_encodable(
                PAYLOAD_INDEX_BY_UUID_STORAGE_PREFIX,
                payload.uuid(),
                &payload_index,
            );
            batch.store_keyed_encodable(
                PAYLOAD_UUID_BY_INDEX_STORAGE_PREFIX,
                &payload_index,
                payload.uuid(),
            );
            debug!(
                ?payload,
                index = payload_index,
                "Updated highest index for incoming payload"
            );
            payload_index
        };
        batch.store_keyed_encodable(PAYLOAD_BY_UUID_STORAGE_PREFIX, payload.uuid(), payload);
        match &payload.status {
            PayloadStatus::ReadyToSubmit | PayloadStatus::Retry(_) => {
                batch.store_keyed_encodable(
                    PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX,
                    &payload_index,
                    payload,
                );
            }
            PayloadStatus::Dropped(_) | PayloadStatus::InTransaction(_) => {
                batch.delete_keyed(PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX, &payload_index);
            }
        }
        batch.store_keyed_encodable(
            PENDING_PAYLOAD_INDEX_WRITE_MARKER_STORAGE_PREFIX,
            &bool::default(),
            &true,
        );
        batch.commit()?;
        drop(_write_guard);
        if let Err(error) = self.mark_pending_payload_index_reconciled().await {
            warn!(
                ?error,
                "Payload committed but pending-index checkpoint could not advance"
            );
        }
        Ok(())
    }

    async fn retrieve_payload_index_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<u32>> {
        self.retrieve_value_by_key(PAYLOAD_INDEX_BY_UUID_STORAGE_PREFIX, payload_uuid)
    }

    async fn store_payload_index_by_uuid(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()> {
        self.store_value_by_key(PAYLOAD_INDEX_BY_UUID_STORAGE_PREFIX, payload_uuid, &index)
    }

    async fn retrieve_payload_uuid_by_index(&self, index: u32) -> DbResult<Option<PayloadUuid>> {
        self.retrieve_value_by_key(PAYLOAD_UUID_BY_INDEX_STORAGE_PREFIX, &index)
    }

    async fn store_payload_uuid_by_index(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()> {
        self.store_value_by_key(PAYLOAD_UUID_BY_INDEX_STORAGE_PREFIX, &index, payload_uuid)
    }

    async fn store_highest_payload_index(&self, index: u32) -> DbResult<()> {
        // There's no unit struct Encode/Decode impl, so just use `bool` and always use the `Default::default()` key
        self.store_value_by_key(
            HIGHEST_PAYLOAD_INDEX_STORAGE_PREFIX,
            &bool::default(),
            &index,
        )
    }

    async fn retrieve_highest_payload_index(&self) -> DbResult<u32> {
        // return the default value (0) if no index has been stored yet
        self.retrieve_value_by_key(HIGHEST_PAYLOAD_INDEX_STORAGE_PREFIX, &bool::default())
            .map(|index: Option<u32>| index.unwrap_or_default())
    }

    async fn retrieve_pending_payloads(&self) -> DbResult<Vec<FullPayload>> {
        let mut payloads =
            self.retrieve_decodables_by_prefix(PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX)?;
        payloads.reverse();
        Ok(payloads)
    }

    async fn pending_payload_index_checkpoint(&self) -> DbResult<Option<u64>> {
        self.retrieve_value_by_key(
            PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX,
            &bool::default(),
        )
    }

    async fn pending_payload_index_requires_reconciliation(
        &self,
        checkpoint: u64,
    ) -> DbResult<bool> {
        match self.has_unmarked_writes_since(
            checkpoint,
            PAYLOAD_BY_UUID_STORAGE_PREFIX,
            PENDING_PAYLOAD_INDEX_WRITE_MARKER_STORAGE_PREFIX,
        ) {
            Ok(requires_reconciliation) => Ok(requires_reconciliation),
            Err(error) => {
                warn!(
                    ?error,
                    checkpoint,
                    "Pending payload index checkpoint is outside the retained WAL; rebuilding"
                );
                Ok(true)
            }
        }
    }

    async fn mark_pending_payload_index_reconciled(&self) -> DbResult<()> {
        let checkpoint = self.latest_sequence_number();
        self.store_value_by_key(
            PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX,
            &bool::default(),
            &checkpoint,
        )
    }

    async fn begin_pending_payload_index_reconciliation(&self) -> DbResult<()> {
        let write_lock = payload_write_lock(self)?;
        let _write_guard = write_lock
            .lock()
            .map_err(|_| DbError::Other("Payload database write lock was poisoned".to_string()))?;
        let mut batch = self.batch();
        batch.delete_prefix(PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX)?;
        batch.delete_keyed(
            PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX,
            &bool::default(),
        );
        batch.commit()
    }

    async fn reconcile_pending_payloads(
        &self,
        first_index: u32,
        last_index: u32,
    ) -> DbResult<Vec<FullPayload>> {
        let write_lock = payload_write_lock(self)?;
        let _write_guard = write_lock
            .lock()
            .map_err(|_| DbError::Other("Payload database write lock was poisoned".to_string()))?;
        let mut batch = self.batch();
        let mut pending_payloads = Vec::new();

        for index in (first_index..=last_index).rev() {
            let Some(payload_uuid) = self.retrieve_value_by_key::<_, PayloadUuid>(
                PAYLOAD_UUID_BY_INDEX_STORAGE_PREFIX,
                &index,
            )?
            else {
                continue;
            };
            let Some(payload) = self.retrieve_value_by_key::<_, FullPayload>(
                PAYLOAD_BY_UUID_STORAGE_PREFIX,
                &payload_uuid,
            )?
            else {
                continue;
            };
            if matches!(
                &payload.status,
                PayloadStatus::ReadyToSubmit | PayloadStatus::Retry(_)
            ) {
                batch.store_keyed_encodable(
                    PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX,
                    &index,
                    &payload,
                );
                pending_payloads.push(payload);
            }
        }
        batch.commit()?;
        Ok(pending_payloads)
    }

    async fn store_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()> {
        self.store_value_by_key(
            TRANSACTION_UUID_BY_PAYLOAD_UUID_STORAGE_PREFIX,
            payload_uuid,
            tx_uuid,
        )
    }

    async fn retrieve_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<TransactionUuid>> {
        self.retrieve_value_by_key(
            TRANSACTION_UUID_BY_PAYLOAD_UUID_STORAGE_PREFIX,
            payload_uuid,
        )
    }
}

impl Encode for FullPayload {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        // Serialize to JSON and write to the writer, to avoid having to implement the encoding manually
        let serialized =
            serde_json::to_vec(self).map_err(|_| std::io::Error::other("Failed to serialize"))?;
        writer.write(&serialized)
    }
}

impl Decode for FullPayload {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        // Deserialize from JSON and read from the reader, to avoid having to implement the encoding / decoding manually
        serde_json::from_reader(reader).map_err(|err| {
            HyperlaneProtocolError::IoError(std::io::Error::other(format!(
                "Failed to deserialize. Error: {err}"
            )))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::{identifiers::UniqueIdentifier, KnownHyperlaneDomain};

    use crate::{
        dispatcher::{BuildingStageQueue, DispatcherMetrics, PayloadDbLoader},
        payload::{FullPayload, PayloadStatus},
        transaction::TransactionStatus,
    };

    use super::{
        PayloadDb, PAYLOAD_BY_UUID_STORAGE_PREFIX, PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX,
        PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX,
    };

    fn db_in(temp_dir: &tempfile::TempDir) -> Arc<HyperlaneRocksDB> {
        let db = DB::from_path(temp_dir.path()).unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();

        Arc::new(HyperlaneRocksDB::new(&domain, db))
    }

    fn tmp_db() -> Arc<HyperlaneRocksDB> {
        db_in(&tempfile::tempdir().unwrap())
    }

    #[tokio::test]
    async fn test_index_is_set_correctly() {
        let num_payloads = 10;
        let db = tmp_db();

        for i in 0..num_payloads {
            let mut payload = FullPayload::random();

            // storing to this new payload UUID for the first time should create a new
            // highest index
            db.store_payload_by_uuid(&payload).await.unwrap();
            let expected_payload_index = (i + 1) as u32;
            let retrieved_payload = db
                .retrieve_payload_by_index(expected_payload_index)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retrieved_payload, payload);
            let highest_index = db.retrieve_highest_payload_index().await.unwrap();
            assert_eq!(highest_index, expected_payload_index);

            // storing to this payload UUID again should not create a new highest index
            payload.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);
            db.store_payload_by_uuid(&payload).await.unwrap();
            let retrieved_payload = db
                .retrieve_payload_by_index(expected_payload_index)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retrieved_payload, payload);
            let highest_index = db.retrieve_highest_payload_index().await.unwrap();
            assert_eq!(highest_index, expected_payload_index);
        }
    }

    #[tokio::test]
    async fn pending_index_tracks_payload_status() {
        let db = tmp_db();
        let mut payload = FullPayload::random();

        db.store_payload_by_uuid(&payload).await.unwrap();
        assert_eq!(
            db.retrieve_pending_payloads().await.unwrap(),
            vec![payload.clone()]
        );

        payload.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);
        db.store_payload_by_uuid(&payload).await.unwrap();
        assert!(db.retrieve_pending_payloads().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn pending_index_preserves_newest_first_order() {
        let db = tmp_db();
        let payloads = (0..3).map(|_| FullPayload::random()).collect::<Vec<_>>();

        for payload in &payloads {
            db.store_payload_by_uuid(payload).await.unwrap();
        }

        assert_eq!(
            db.retrieve_pending_payloads().await.unwrap(),
            payloads.into_iter().rev().collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn loader_backfills_missing_pending_index() {
        let db = tmp_db();
        let payload = FullPayload::random();
        db.store_payload_by_uuid(&payload).await.unwrap();

        // Simulate a database written before the pending index existed.
        let payload_index = db
            .retrieve_payload_index_by_uuid(payload.uuid())
            .await
            .unwrap()
            .unwrap();
        let mut batch = db.batch();
        batch.delete_keyed(PENDING_PAYLOAD_BY_INDEX_STORAGE_PREFIX, &payload_index);
        batch.delete_keyed(
            PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX,
            &bool::default(),
        );
        batch.commit().unwrap();

        let queue = BuildingStageQueue::new();
        let loader = PayloadDbLoader::new(db.clone(), queue.clone(), "test".to_string());
        let metrics = DispatcherMetrics::dummy_instance();
        loader.load_from_db(metrics.clone()).await.unwrap();

        assert!(db
            .pending_payload_index_checkpoint()
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            db.retrieve_pending_payloads().await.unwrap(),
            vec![payload.clone()]
        );
        assert_eq!(queue.pop_n(1).await, vec![payload]);
        assert!(!String::from_utf8(metrics.gather().unwrap())
            .unwrap()
            .contains("PayloadDbLoader"));
    }

    #[tokio::test]
    async fn loader_reconciles_writes_from_rollback_binary() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = db_in(&temp_dir);
        let mut becomes_terminal = FullPayload::random();
        let mut becomes_pending = FullPayload::random();
        becomes_pending.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);
        db.store_payload_by_uuid(&becomes_terminal).await.unwrap();
        db.store_payload_by_uuid(&becomes_pending).await.unwrap();

        let checkpoint = db
            .pending_payload_index_checkpoint()
            .await
            .unwrap()
            .unwrap();
        assert!(!db
            .pending_payload_index_requires_reconciliation(checkpoint)
            .await
            .unwrap());

        // Simulate the old binary: it updates canonical payloads but does not
        // maintain the new index/write marker.
        becomes_terminal.status = PayloadStatus::InTransaction(TransactionStatus::PendingInclusion);
        db.store_value_by_key(
            PAYLOAD_BY_UUID_STORAGE_PREFIX,
            becomes_terminal.uuid(),
            &becomes_terminal,
        )
        .unwrap();
        becomes_pending.status = PayloadStatus::ReadyToSubmit;
        db.store_value_by_key(
            PAYLOAD_BY_UUID_STORAGE_PREFIX,
            becomes_pending.uuid(),
            &becomes_pending,
        )
        .unwrap();
        let legacy_new_pending = FullPayload::random();
        db.store_highest_payload_index(3).await.unwrap();
        db.store_payload_index_by_uuid(3, legacy_new_pending.uuid())
            .await
            .unwrap();
        db.store_payload_uuid_by_index(3, legacy_new_pending.uuid())
            .await
            .unwrap();
        db.store_value_by_key(
            PAYLOAD_BY_UUID_STORAGE_PREFIX,
            legacy_new_pending.uuid(),
            &legacy_new_pending,
        )
        .unwrap();

        assert!(db
            .pending_payload_index_requires_reconciliation(checkpoint)
            .await
            .unwrap());

        let queue = BuildingStageQueue::new();
        PayloadDbLoader::new(db.clone(), queue.clone(), "test".to_string())
            .load_from_db(DispatcherMetrics::dummy_instance())
            .await
            .unwrap();

        assert_eq!(
            db.retrieve_pending_payloads().await.unwrap(),
            vec![legacy_new_pending.clone(), becomes_pending.clone()]
        );
        assert_eq!(
            queue.pop_n(3).await,
            vec![legacy_new_pending, becomes_pending]
        );
    }

    #[tokio::test]
    async fn loader_rebuilds_sparse_history_in_bounded_batches() {
        let db = tmp_db();
        let payload = FullPayload::random();
        db.store_payload_by_uuid(&payload).await.unwrap();
        db.store_highest_payload_index(2_501).await.unwrap();

        let mut batch = db.batch();
        batch.delete_keyed(
            PENDING_PAYLOAD_INDEX_CHECKPOINT_STORAGE_PREFIX,
            &bool::default(),
        );
        batch.commit().unwrap();
        let sequence_before = db.latest_sequence_number();

        let queue = BuildingStageQueue::new();
        PayloadDbLoader::new(db.clone(), queue.clone(), "test".to_string())
            .load_from_db(DispatcherMetrics::dummy_instance())
            .await
            .unwrap();

        let sequence_writes = db.latest_sequence_number().saturating_sub(sequence_before);
        assert!(sequence_writes <= 5, "used {sequence_writes} writes");
        assert_eq!(queue.pop_n(1).await, vec![payload]);
    }
}
