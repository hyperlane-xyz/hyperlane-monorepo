// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, LazyLock, Mutex},
};

use async_trait::async_trait;
use hyperlane_base::db::{DbError, DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError};
use tracing::info;

use crate::transaction::{Transaction, TransactionUuid};

const TRANSACTION_BY_UUID_STORAGE_PREFIX: &str = "transaction_by_uuid_";

const TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX: &str = "tx_index_by_uuid_";
const TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX: &str = "tx_uuid_by_index_";
const HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX: &str = "highest_tx_index_";
static TRANSACTION_WRITE_LOCKS: LazyLock<Mutex<HashMap<u32, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[async_trait]
pub trait TransactionDb: Send + Sync {
    /// Repair legacy split index writes from canonical records. Implementations
    /// whose index updates are already atomic need no reconciliation.
    async fn reconcile_transaction_index(&self) -> DbResult<()> {
        Ok(())
    }
    /// Retrieve a transaction by its unique ID
    async fn retrieve_transaction_by_uuid(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<Option<Transaction>>;

    /// Store a transaction by its unique ID
    async fn store_transaction_by_uuid(&self, tx: &Transaction) -> DbResult<()>;

    /// Retrieve a transaction's index by its unique ID
    async fn retrieve_transaction_index_by_uuid(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<Option<u32>>;

    /// Store a transaction's index by its unique ID
    async fn store_transaction_index_by_uuid(
        &self,
        index: u32,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()>;

    /// Retrieve a transaction's unique ID by its index
    async fn retrieve_transaction_uuid_by_index(
        &self,
        index: u32,
    ) -> DbResult<Option<TransactionUuid>>;

    /// Store a transaction's unique ID by its index
    async fn store_transaction_uuid_by_index(
        &self,
        index: u32,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()>;

    /// Retrieve a transaction by its index
    async fn retrieve_transaction_by_index(&self, index: u32) -> DbResult<Option<Transaction>> {
        let id = self.retrieve_transaction_uuid_by_index(index).await?;
        if let Some(id) = id {
            self.retrieve_transaction_by_uuid(&id).await
        } else {
            Ok(None)
        }
    }

    /// Store the highest transaction index
    async fn store_highest_transaction_index(&self, index: u32) -> DbResult<()>;

    /// Retrieve the highest transaction index
    async fn retrieve_highest_transaction_index(&self) -> DbResult<u32>;
}

// Serialize allocation and index repair with the canonical record commit.
// Reconciliation passes false so healthy historical records are only read.
fn persist_transaction(
    db: &HyperlaneRocksDB,
    tx: &Transaction,
    write_record: bool,
) -> DbResult<()> {
    let lock = TRANSACTION_WRITE_LOCKS
        .lock()
        .map_err(|_| DbError::Other("Transaction write-lock registry was poisoned".into()))?
        .entry(db.domain().id())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    let _guard = lock
        .lock()
        .map_err(|_| DbError::Other("Transaction database write lock was poisoned".into()))?;
    let mut batch = db.batch();
    let existing_index: Option<u32> =
        db.retrieve_value_by_key(TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX, &tx.uuid)?;
    let highest_index: u32 = db
        .retrieve_value_by_key(HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX, &bool::default())?
        .unwrap_or_default();
    let index = match existing_index {
        Some(0) => return Err(DbError::Other("Transaction index zero is invalid".into())),
        Some(index) => index,
        None => highest_index.checked_add(1).ok_or_else(|| {
            DbError::Other("Highest transaction index exhausted (u32::MAX)".into())
        })?,
    };
    let reverse: Option<TransactionUuid> =
        db.retrieve_value_by_key(TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX, &index)?;
    if reverse.as_ref().is_some_and(|owner| owner != &tx.uuid) {
        return Err(DbError::Other(format!(
            "Transaction index {index} belongs to another UUID"
        )));
    }
    let mut changed = false;
    if index > highest_index {
        batch.store_keyed_encodable(
            HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX,
            &bool::default(),
            &index,
        );
        changed = true;
    }
    if existing_index.is_none() {
        batch.store_keyed_encodable(TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX, &tx.uuid, &index);
        changed = true;
    }
    if reverse.is_none() {
        batch.store_keyed_encodable(TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX, &index, &tx.uuid);
        changed = true;
    }
    if write_record {
        batch.store_keyed_encodable(TRANSACTION_BY_UUID_STORAGE_PREFIX, &tx.uuid, tx);
        changed = true;
    }
    if changed {
        batch.commit()
    } else {
        Ok(())
    }
}

#[async_trait]
impl TransactionDb for HyperlaneRocksDB {
    async fn reconcile_transaction_index(&self) -> DbResult<()> {
        let mut after = Vec::new();
        let mut page_size = 0_u32;
        let mut scanned = 0_u64;
        while let Some((mut key, tx)) = self.retrieve_by_prefix_at_or_after::<Transaction>(
            TRANSACTION_BY_UUID_STORAGE_PREFIX,
            &after,
        )? {
            if key.as_slice() != tx.uuid.as_bytes() {
                return Err(DbError::Other(
                    "Canonical transaction key does not match its UUID".into(),
                ));
            }
            persist_transaction(self, &tx, false)?;
            // UUID keys have fixed length. Appending zero seeks strictly past
            // this record without skipping its lexicographic successor.
            key.push(0);
            after = key;
            page_size = page_size.saturating_add(1);
            scanned = scanned.saturating_add(1);
            if page_size >= 1_000 {
                info!(
                    domain = self.domain().name(),
                    scanned, "Reconciling transaction recovery indexes"
                );
                tokio::task::yield_now().await;
                page_size = 0;
            }
        }
        info!(
            domain = self.domain().name(),
            scanned, "Transaction recovery indexes reconciled"
        );
        Ok(())
    }
    async fn retrieve_transaction_by_uuid(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<Option<Transaction>> {
        self.retrieve_decodable(TRANSACTION_BY_UUID_STORAGE_PREFIX, tx_uuid.as_bytes())
    }

    async fn store_transaction_by_uuid(&self, tx: &Transaction) -> DbResult<()> {
        persist_transaction(self, tx, true)
    }

    async fn retrieve_transaction_index_by_uuid(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<Option<u32>> {
        self.retrieve_decodable(TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX, tx_uuid.as_bytes())
    }
    async fn store_transaction_index_by_uuid(
        &self,
        index: u32,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()> {
        self.store_value_by_key(TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX, tx_uuid, &index)
    }

    async fn retrieve_transaction_uuid_by_index(
        &self,
        index: u32,
    ) -> DbResult<Option<TransactionUuid>> {
        self.retrieve_value_by_key(TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX, &index)
    }

    async fn store_transaction_uuid_by_index(
        &self,
        index: u32,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()> {
        self.store_value_by_key(TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX, &index, tx_uuid)
    }

    async fn store_highest_transaction_index(&self, index: u32) -> DbResult<()> {
        // There's no unit struct Encode/Decode impl, so just use `bool` and always use the `Default::default()` key
        self.store_value_by_key(
            HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX,
            &bool::default(),
            &index,
        )
    }

    async fn retrieve_highest_transaction_index(&self) -> DbResult<u32> {
        // return the default value (0) if no index has been stored yet
        self.retrieve_value_by_key(HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX, &bool::default())
            .map(|index| index.unwrap_or_default())
    }
}

impl Encode for Transaction {
    fn to_vec(&self) -> Vec<u8> {
        // Database writes need the JSON buffer itself, not a copy through write_to.
        serde_json::to_vec(self)
            .map_err(|_| std::io::Error::other("Failed to serialize"))
            .expect("!alloc")
    }

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

impl Decode for Transaction {
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

    fn read_from_slice(bytes: &[u8]) -> Result<Self, HyperlaneProtocolError> {
        serde_json::from_slice(bytes).map_err(|err| {
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
    use hyperlane_core::KnownHyperlaneDomain;

    use crate::tests::test_utils::dummy_tx;
    use crate::transaction::TransactionUuid;
    use crate::{payload::FullPayload, transaction::TransactionStatus};

    use super::TransactionDb;

    fn tmp_db() -> Arc<dyn TransactionDb> {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();

        (Arc::new(HyperlaneRocksDB::new(&domain, db))) as _
    }

    #[test]
    fn transaction_owned_encoding_matches_writer_and_roundtrips() {
        use crate::transaction::{DropReason, Transaction};
        use hyperlane_core::{Decode, Encode, H512};
        for length in [0, 1, 4096, 65536] {
            for status in [
                TransactionStatus::PendingInclusion,
                TransactionStatus::Mempool,
                TransactionStatus::Included,
                TransactionStatus::Finalized,
                TransactionStatus::Dropped(DropReason::Other("retry \"quoted\" reason".to_owned())),
            ] {
                let mut payload = FullPayload::default();
                payload.details.metadata = "x".repeat(length);
                payload.details.success_criteria = Some(vec![0, 255, 1]);
                let mut tx = dummy_tx(vec![payload], status);
                tx.tx_hashes = vec![H512::repeat_byte(0x12), H512::repeat_byte(0x34)];
                tx.submission_attempts = u32::MAX;
                tx.last_submission_attempt = Some(tx.creation_timestamp);
                tx.last_status_check = Some(tx.creation_timestamp);
                let mut legacy = Vec::new();
                assert_eq!(tx.write_to(&mut legacy).unwrap(), legacy.len());
                let encoded = tx.to_vec();
                assert_eq!(encoded, legacy);
                assert_eq!(Transaction::read_from(&mut encoded.as_slice()).unwrap(), tx);
                let mut partial = [0; 1];
                assert_eq!(tx.write_to(&mut partial.as_mut_slice()).unwrap(), 1);
                assert_eq!(partial[0], encoded[0]);
            }
        }
    }

    #[tokio::test]
    async fn test_index_is_set_correctly() {
        let num_txs = 10;
        let db = tmp_db();

        for i in 0..num_txs {
            let payload = FullPayload::random();
            let mut tx = dummy_tx(vec![payload.clone()], TransactionStatus::PendingInclusion);

            // storing to this new tx ID for the first time should create a new
            db.store_transaction_by_uuid(&tx).await.unwrap();
            let expected_index = i + 1;
            let retrieved_tx = db
                .retrieve_transaction_by_index(expected_index as u32)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retrieved_tx, tx);
            let highest_index = db.retrieve_highest_transaction_index().await.unwrap();
            assert_eq!(highest_index, expected_index as u32);

            // storing to this new tx ID again should not create a new
            // highest index
            tx.status = TransactionStatus::Included;
            db.store_transaction_by_uuid(&tx).await.unwrap();
            let retrieved_tx = db
                .retrieve_transaction_by_index(expected_index as u32)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retrieved_tx, tx);
            let highest_index = db.retrieve_highest_transaction_index().await.unwrap();
            assert_eq!(highest_index, expected_index as u32);
        }
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_transaction_creations_preserve_unique_recovery_indexes() {
        use hyperlane_base::db::{HyperlaneRocksDB, DB};
        use hyperlane_core::KnownHyperlaneDomain;
        let directory = tempfile::tempdir().unwrap();
        let db = Arc::new(HyperlaneRocksDB::new(
            &KnownHyperlaneDomain::Arbitrum.into(),
            DB::from_path(directory.path()).unwrap(),
        ));
        let barrier = Arc::new(tokio::sync::Barrier::new(32));
        let tasks: Vec<_> = (0..32)
            .map(|_| {
                let db = db.clone();
                let barrier = barrier.clone();
                tokio::spawn(async move {
                    let tx = dummy_tx(vec![], TransactionStatus::PendingInclusion);
                    barrier.wait().await;
                    db.store_transaction_by_uuid(&tx).await.unwrap();
                    tx
                })
            })
            .collect();
        let mut indexes = std::collections::HashSet::new();
        for task in tasks {
            let mut tx = task.await.unwrap();
            let index = db
                .retrieve_transaction_index_by_uuid(&tx.uuid)
                .await
                .unwrap()
                .unwrap();
            assert!(indexes.insert(index));
            assert_eq!(
                db.retrieve_transaction_by_index(index).await.unwrap(),
                Some(tx.clone())
            );
            tx.status = TransactionStatus::Mempool;
            db.store_transaction_by_uuid(&tx).await.unwrap();
            assert_eq!(
                db.retrieve_transaction_index_by_uuid(&tx.uuid)
                    .await
                    .unwrap(),
                Some(index)
            );
        }
        assert_eq!(db.retrieve_highest_transaction_index().await.unwrap(), 32);
    }
    #[tokio::test]
    async fn legacy_forward_index_repairs_reverse_and_high_watermark_without_reallocation() {
        let directory = tempfile::tempdir().unwrap();
        let db = HyperlaneRocksDB::new(
            &KnownHyperlaneDomain::Arbitrum.into(),
            DB::from_path(directory.path()).unwrap(),
        );
        let tx = dummy_tx(vec![], TransactionStatus::PendingInclusion);
        db.store_transaction_index_by_uuid(12, &tx.uuid)
            .await
            .unwrap();
        db.store_highest_transaction_index(3).await.unwrap();
        db.store_transaction_by_uuid(&tx).await.unwrap();
        assert_eq!(db.retrieve_highest_transaction_index().await.unwrap(), 12);
        assert_eq!(
            db.retrieve_transaction_by_index(12).await.unwrap(),
            Some(tx.clone())
        );
        let mut newer = tx.clone();
        newer.status = TransactionStatus::Mempool;
        db.store_transaction_by_uuid(&newer).await.unwrap();
        // A reconciliation read can race a live status update. Repairing the
        // older snapshot's index must never write its stale canonical body.
        super::persist_transaction(&db, &tx, false).unwrap();
        assert_eq!(
            db.retrieve_transaction_by_uuid(&tx.uuid).await.unwrap(),
            Some(newer)
        );
    }

    #[tokio::test]
    async fn conflicting_legacy_reverse_index_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let db = HyperlaneRocksDB::new(
            &KnownHyperlaneDomain::Arbitrum.into(),
            DB::from_path(directory.path()).unwrap(),
        );
        let tx = dummy_tx(vec![], TransactionStatus::PendingInclusion);
        let owner = TransactionUuid::random();
        db.store_transaction_index_by_uuid(12, &tx.uuid)
            .await
            .unwrap();
        db.store_transaction_uuid_by_index(12, &owner)
            .await
            .unwrap();
        assert!(db.store_transaction_by_uuid(&tx).await.is_err());
        assert_eq!(
            db.retrieve_transaction_uuid_by_index(12).await.unwrap(),
            Some(owner)
        );
        assert!(db
            .retrieve_transaction_by_uuid(&tx.uuid)
            .await
            .unwrap()
            .is_none());
    }
}
