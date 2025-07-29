use std::io::Write;

use hyperlane_core::{Decode, Encode, HyperlaneProtocolError};

use crate::transaction::TransactionUuid;
use crate::TransactionStatus;
use crate::TransactionStatus::{Finalized, Included, Mempool, PendingInclusion};

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub(crate) enum NonceStatus {
    /// The nonce which we track, but is not currently assigned to any transaction.
    Freed(TransactionUuid),
    /// The nonce is currently assigned to a transaction but not finalised.
    Taken(TransactionUuid),
    /// The nonce is assigned to a transaction that has been finalised.
    Committed(TransactionUuid),
}

impl NonceStatus {
    pub(crate) fn calculate_nonce_status(
        tx_uuid: TransactionUuid,
        tx_status: &TransactionStatus,
    ) -> NonceStatus {
        use NonceStatus::{Committed, Freed, Taken};
        use TransactionStatus::{Dropped, Finalized, Included, Mempool, PendingInclusion};

        match tx_status {
            PendingInclusion | Mempool | Included => Taken(tx_uuid),
            Finalized => Committed(tx_uuid),
            Dropped(_) => Freed(tx_uuid),
        }
    }
}
impl Encode for NonceStatus {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        // Serialize to JSON and write to the writer to avoid having to implement the encoding manually
        let serialized = serde_json::to_vec(self)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "Failed to serialize"))?;
        writer.write(&serialized)
    }
}

impl Decode for NonceStatus {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        // Deserialize from JSON and read from the reader to avoid having to implement the encoding / decoding manually
        serde_json::from_reader(reader).map_err(|err| {
            HyperlaneProtocolError::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to deserialize. Error: {}", err),
            ))
        })
    }
}

#[cfg(test)]
mod tests;
