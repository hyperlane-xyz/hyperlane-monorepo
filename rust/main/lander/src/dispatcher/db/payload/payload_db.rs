// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::io::Write;

use async_trait::async_trait;
use eyre::eyre;
use hyperlane_base::db::{DbError, DbResult, HyperlaneRocksDB};
use hyperlane_core::{identifiers::UniqueIdentifier, Decode, Encode, HyperlaneProtocolError};
use tracing::debug;

use crate::{
    payload::{self, FullPayload, PayloadStatus, PayloadUuid},
    transaction::TransactionUuid,
};

const PAYLOAD_BY_UUID_STORAGE_PREFIX: &str = "payload_by_uuid_";
const TRANSACTION_UUID_BY_PAYLOAD_UUID_STORAGE_PREFIX: &str = "transaction_uuid_by_payload_uuid_";
const PAYLOAD_INDEX_BY_UUID_STORAGE_PREFIX: &str = "payload_index_by_uuid_";
const PAYLOAD_UUID_BY_INDEX_STORAGE_PREFIX: &str = "payload_uuid_by_index_";
const HIGHEST_PAYLOAD_INDEX_STORAGE_PREFIX: &str = "highest_payload_index_";

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
                "Payload with UUID {:?} not found",
                payload_uuid
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
        if self
            .retrieve_payload_index_by_uuid(payload.uuid())
            .await?
            .is_none()
        {
            let highest_index = self.retrieve_highest_payload_index().await?;
            let payload_index = highest_index + 1;
            self.store_highest_payload_index(payload_index).await?;
            self.store_payload_index_by_uuid(payload_index, payload.uuid())
                .await?;
            self.store_payload_uuid_by_index(payload_index, payload.uuid())
                .await?;
            debug!(
                ?payload,
                index = payload_index,
                "Updated highest index for incoming payload"
            );
        } else {
            debug!(
                payload_uuid = ?payload.uuid(),
                "Payload with UUID already exists, not updating index",
            );
        }
        self.store_value_by_key(PAYLOAD_BY_UUID_STORAGE_PREFIX, payload.uuid(), payload)
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
        let serialized = serde_json::to_vec(self)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "Failed to serialize"))?;
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
            HyperlaneProtocolError::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to deserialize. Error: {}", err),
            ))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use hyperlane_base::db::{HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;

    use crate::{
        payload::{FullPayload, PayloadStatus},
        transaction::TransactionStatus,
    };

    use super::PayloadDb;

    fn tmp_db() -> Arc<dyn PayloadDb> {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();
        let rocksdb = Arc::new(HyperlaneRocksDB::new(&domain, db));
        rocksdb
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
}
