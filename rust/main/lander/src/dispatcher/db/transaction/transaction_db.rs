// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::io::Write;

use async_trait::async_trait;
use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError};

use crate::transaction::{Transaction, TransactionStatus, TransactionUuid};

const TRANSACTION_BY_UUID_STORAGE_PREFIX: &str = "transaction_by_uuid_";

const TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX: &str = "tx_index_by_uuid_";
const TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX: &str = "tx_uuid_by_index_";
const HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX: &str = "highest_tx_index_";
const FINALIZED_TRANSACTION_COUNT_STORAGE_PREFIX: &str = "finalized_tx_count_";

#[async_trait]
pub trait TransactionDb: Send + Sync {
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

    /// Retrieve persisted finalized transaction count.
    async fn retrieve_finalized_transaction_count(&self) -> DbResult<Option<u64>> {
        Ok(None)
    }

    /// Persist finalized transaction count.
    async fn store_finalized_transaction_count(&self, _count: u64) -> DbResult<()> {
        Ok(())
    }

    /// Count transactions currently matching a status.
    async fn count_transactions_by_status(&self, status: &TransactionStatus) -> DbResult<u64> {
        let mut count = 0_u64;
        let highest_index = self.retrieve_highest_transaction_index().await?;
        for index in 1..=highest_index {
            if let Some(tx) = self.retrieve_transaction_by_index(index).await? {
                if &tx.status == status {
                    count = count.saturating_add(1);
                }
            }
            // This recount loop can iterate over many records when recovering legacy
            // state; yield so startup work does not monopolize runtime threads.
            tokio::task::yield_now().await;
        }
        Ok(count)
    }

    /// Recount finalized transactions from DB and persist the value.
    async fn recount_finalized_transaction_count(&self) -> DbResult<u64> {
        let count = self
            .count_transactions_by_status(&TransactionStatus::Finalized)
            .await?;
        self.store_finalized_transaction_count(count).await?;
        Ok(count)
    }

    /// Increment persisted finalized transaction count.
    async fn increment_finalized_transaction_count(&self) -> DbResult<u64> {
        let count = self
            .retrieve_finalized_transaction_count()
            .await?
            .unwrap_or_default()
            .saturating_add(1);
        self.store_finalized_transaction_count(count).await?;
        Ok(count)
    }

    /// Decrement persisted finalized transaction count.
    async fn decrement_finalized_transaction_count(&self) -> DbResult<u64> {
        let count = self
            .retrieve_finalized_transaction_count()
            .await?
            .unwrap_or_default()
            .saturating_sub(1);
        self.store_finalized_transaction_count(count).await?;
        Ok(count)
    }
}

#[async_trait]
impl TransactionDb for HyperlaneRocksDB {
    async fn retrieve_transaction_by_uuid(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<Option<Transaction>> {
        self.retrieve_value_by_key(TRANSACTION_BY_UUID_STORAGE_PREFIX, tx_uuid)
    }

    async fn store_transaction_by_uuid(&self, tx: &Transaction) -> DbResult<()> {
        if self
            .retrieve_transaction_index_by_uuid(&tx.uuid)
            .await?
            .is_none()
        {
            let highest_index = self.retrieve_highest_transaction_index().await?;
            let tx_index = highest_index.saturating_add(1);
            self.store_highest_transaction_index(tx_index).await?;
            self.store_transaction_index_by_uuid(tx_index, &tx.uuid)
                .await?;
            self.store_transaction_uuid_by_index(tx_index, &tx.uuid)
                .await?;
        }
        self.store_value_by_key(TRANSACTION_BY_UUID_STORAGE_PREFIX, &tx.uuid, tx)
    }

    async fn retrieve_transaction_index_by_uuid(
        &self,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<Option<u32>> {
        self.retrieve_value_by_key(TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX, tx_uuid)
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

    async fn retrieve_finalized_transaction_count(&self) -> DbResult<Option<u64>> {
        self.retrieve_value_by_key(FINALIZED_TRANSACTION_COUNT_STORAGE_PREFIX, &bool::default())
    }

    async fn store_finalized_transaction_count(&self, count: u64) -> DbResult<()> {
        self.store_value_by_key(
            FINALIZED_TRANSACTION_COUNT_STORAGE_PREFIX,
            &bool::default(),
            &count,
        )
    }
}

impl Encode for Transaction {
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
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;

    use crate::tests::test_utils::dummy_tx;
    use crate::transaction::{DropReason, TransactionUuid};
    use crate::{payload::FullPayload, transaction::TransactionStatus};

    use super::TransactionDb;

    fn tmp_db() -> Arc<dyn TransactionDb> {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();

        (Arc::new(HyperlaneRocksDB::new(&domain, db))) as _
    }

    #[tokio::test]
    async fn test_transaction_indexing_is_one_based() {
        let db = tmp_db();

        assert_eq!(db.retrieve_highest_transaction_index().await.unwrap(), 0);
        assert_eq!(db.retrieve_transaction_by_index(0).await.unwrap(), None);

        let payload = FullPayload::random();
        let tx = dummy_tx(vec![payload], TransactionStatus::PendingInclusion);
        db.store_transaction_by_uuid(&tx).await.unwrap();

        assert_eq!(db.retrieve_highest_transaction_index().await.unwrap(), 1);
        assert_eq!(
            db.retrieve_transaction_index_by_uuid(&tx.uuid)
                .await
                .unwrap(),
            Some(1)
        );
        assert_eq!(db.retrieve_transaction_by_index(1).await.unwrap(), Some(tx));
        assert_eq!(db.retrieve_transaction_by_index(0).await.unwrap(), None);
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

    #[tokio::test]
    async fn test_count_transactions_by_status() {
        let db = tmp_db();
        let statuses = vec![
            TransactionStatus::PendingInclusion,
            TransactionStatus::Finalized,
            TransactionStatus::Included,
            TransactionStatus::Finalized,
            TransactionStatus::Dropped(DropReason::DroppedByChain),
        ];

        for status in statuses {
            let payload = FullPayload::random();
            let tx = dummy_tx(vec![payload], status);
            db.store_transaction_by_uuid(&tx).await.unwrap();
        }

        let finalized_count = db
            .count_transactions_by_status(&TransactionStatus::Finalized)
            .await
            .unwrap();
        let included_count = db
            .count_transactions_by_status(&TransactionStatus::Included)
            .await
            .unwrap();

        assert_eq!(finalized_count, 2);
        assert_eq!(included_count, 1);
    }

    #[tokio::test]
    async fn test_recount_finalized_transaction_count_persists_value() {
        let db = tmp_db();
        for status in [
            TransactionStatus::Finalized,
            TransactionStatus::Included,
            TransactionStatus::Finalized,
        ] {
            let payload = FullPayload::random();
            let tx = dummy_tx(vec![payload], status);
            db.store_transaction_by_uuid(&tx).await.unwrap();
        }

        let recounted = db.recount_finalized_transaction_count().await.unwrap();
        let stored = db.retrieve_finalized_transaction_count().await.unwrap();
        assert_eq!(recounted, 2);
        assert_eq!(stored, Some(2));
    }

    #[tokio::test]
    async fn test_increment_and_decrement_finalized_transaction_count() {
        let db = tmp_db();
        assert_eq!(
            db.retrieve_finalized_transaction_count().await.unwrap(),
            None
        );

        let c1 = db.increment_finalized_transaction_count().await.unwrap();
        let c2 = db.increment_finalized_transaction_count().await.unwrap();
        let c3 = db.decrement_finalized_transaction_count().await.unwrap();
        let c4 = db.decrement_finalized_transaction_count().await.unwrap();
        let c5 = db.decrement_finalized_transaction_count().await.unwrap();

        assert_eq!((c1, c2, c3, c4, c5), (1, 2, 1, 0, 0));
        assert_eq!(
            db.retrieve_finalized_transaction_count().await.unwrap(),
            Some(0)
        );
    }
}
