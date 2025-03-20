// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::io::Write;

use hyperlane_base::db::{DbResult, HyperlaneRocksDB};
use hyperlane_core::{Decode, Encode, HyperlaneProtocolError};

use super::{FullPayload, PayloadId};

const PAYLOAD_BY_ID_STORAGE_PREFIX: &str = "payload_by_id_";

pub trait PayloadDb {
    /// Retrieve the nonce of the highest processed message we're aware of
    fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>>;

    /// Retrieve a message by its nonce
    fn store_payload_by_id(&self, payload: FullPayload) -> DbResult<()>;
}

impl PayloadDb for HyperlaneRocksDB {
    fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>> {
        self.retrieve_value_by_key(PAYLOAD_BY_ID_STORAGE_PREFIX, id)
    }

    fn store_payload_by_id(&self, payload: FullPayload) -> DbResult<()> {
        self.store_value_by_key(PAYLOAD_BY_ID_STORAGE_PREFIX, payload.id(), &payload)
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
