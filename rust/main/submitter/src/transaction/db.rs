// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::io::Write;

use async_trait::async_trait;
use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError};

use super::{Transaction, TransactionId};

const TRANSACTION_BY_ID_STORAGE_PREFIX: &str = "transaction_by_id_";

// The `nonce` → `tx_uuid` store is updated as well
const NONCE_BY_TX_ID_STORAGE_PREFIX: &str = "nonce_by_tx_id_";

#[async_trait]
pub trait TransactionDb: Send + Sync {
    /// Retrieve a transaction by its unique ID
    async fn retrieve_transaction_by_id(&self, id: &TransactionId)
        -> DbResult<Option<Transaction>>;

    /// Store a transaction by its unique ID
    async fn store_transaction_by_id(&self, tx: &Transaction) -> DbResult<()>;
}

#[async_trait]
impl TransactionDb for HyperlaneRocksDB {
    async fn retrieve_transaction_by_id(
        &self,
        id: &TransactionId,
    ) -> DbResult<Option<Transaction>> {
        self.retrieve_value_by_key(TRANSACTION_BY_ID_STORAGE_PREFIX, id)
    }

    async fn store_transaction_by_id(&self, tx: &Transaction) -> DbResult<()> {
        self.store_value_by_key(TRANSACTION_BY_ID_STORAGE_PREFIX, &tx.id, tx)
    }
}

impl Encode for Transaction {
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

impl Decode for Transaction {
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
