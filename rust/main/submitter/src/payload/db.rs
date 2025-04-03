// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::io::Write;

use async_trait::async_trait;
use eyre::eyre;
use hyperlane_base::db::{DbError, DbResult, HyperlaneRocksDB};
use hyperlane_core::{identifiers::UniqueIdentifier, Decode, Encode, HyperlaneProtocolError};

use crate::transaction::TransactionId;

use super::{FullPayload, PayloadId, PayloadStatus};

const PAYLOAD_BY_ID_STORAGE_PREFIX: &str = "payload_by_id_";
const TRANSACTION_ID_BY_PAYLOAD_ID_STORAGE_PREFIX: &str = "transaction_id_by_payload_id_";

#[async_trait]
pub trait PayloadDb: Send + Sync {
    /// Retrieve a payload by its unique ID
    async fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>>;

    /// Store a payload by its unique ID
    async fn store_payload_by_id(&self, payload: FullPayload) -> DbResult<()>;

    /// Set the status of a payload by its unique ID. Performs one read (to first fetch the full payload) and one write.
    async fn store_new_payload_status(
        &self,
        id: &PayloadId,
        new_status: PayloadStatus,
    ) -> DbResult<()> {
        let mut payload = self
            .retrieve_payload_by_id(id)
            .await?
            .ok_or(DbError::Other("Payload doesn't exist".to_owned()))?;
        payload.status = new_status;
        self.store_payload_by_id(payload)
            .await
            .map_err(|err| DbError::Other(format!("Failed to store payload: {:?}", err)))?;
        Ok(())
    }

    async fn store_tx_id_by_payload_id(
        &self,
        payload_id: &PayloadId,
        tx_id: &TransactionId,
    ) -> DbResult<()>;

    async fn retrieve_tx_id_by_payload_id(
        &self,
        payload_id: &PayloadId,
    ) -> DbResult<Option<TransactionId>>;
}

#[async_trait]
impl PayloadDb for HyperlaneRocksDB {
    async fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>> {
        self.retrieve_value_by_key(PAYLOAD_BY_ID_STORAGE_PREFIX, id)
    }

    async fn store_payload_by_id(&self, payload: FullPayload) -> DbResult<()> {
        self.store_value_by_key(PAYLOAD_BY_ID_STORAGE_PREFIX, payload.id(), &payload)
    }

    async fn store_tx_id_by_payload_id(
        &self,
        payload_id: &PayloadId,
        tx_id: &TransactionId,
    ) -> DbResult<()> {
        self.store_value_by_key(
            TRANSACTION_ID_BY_PAYLOAD_ID_STORAGE_PREFIX,
            payload_id,
            tx_id,
        )
    }

    async fn retrieve_tx_id_by_payload_id(
        &self,
        payload_id: &PayloadId,
    ) -> DbResult<Option<TransactionId>> {
        self.retrieve_value_by_key(TRANSACTION_ID_BY_PAYLOAD_ID_STORAGE_PREFIX, payload_id)
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
