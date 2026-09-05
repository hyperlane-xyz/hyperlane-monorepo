// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::io::Write;

use async_trait::async_trait;
use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError};

use crate::transaction::{Transaction, TransactionUuid};

const TRANSACTION_BY_UUID_STORAGE_PREFIX: &str = "transaction_by_uuid_";

const TRANSACTION_INDEX_BY_UUID_STORAGE_PREFIX: &str = "tx_index_by_uuid_";
const TRANSACTION_UUID_BY_INDEX_STORAGE_PREFIX: &str = "tx_uuid_by_index_";
const HIGHEST_TRANSACTION_INDEX_STORAGE_PREFIX: &str = "highest_tx_index_";

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
}
