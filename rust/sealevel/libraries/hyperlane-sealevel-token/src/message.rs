//! The Hyperlane Token message format.

use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H256, U256};

/// Message contents sent or received by a Hyperlane Token program to indicate
/// a remote token transfer.
#[derive(Debug)]
pub struct TokenMessage {
    recipient: H256,
    amount_or_id: U256,
    metadata: Vec<u8>,
}

impl Encode for TokenMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self.recipient.as_ref())?;

        let mut amount_or_id = [0_u8; 32];
        self.amount_or_id.to_big_endian(&mut amount_or_id);
        writer.write_all(&amount_or_id)?;

        writer.write_all(&self.metadata)?;

        Ok(32 + 32 + self.metadata.len())
    }
}

impl Decode for TokenMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut recipient = H256::zero();
        reader.read_exact(recipient.as_mut())?;

        let mut amount_or_id = [0_u8; 32];
        reader.read_exact(&mut amount_or_id)?;
        let amount_or_id = U256::from_big_endian(&amount_or_id);

        let mut metadata = vec![];
        reader.read_to_end(&mut metadata)?;

        Ok(Self {
            recipient,
            amount_or_id,
            metadata,
        })
    }
}

impl TokenMessage {
    /// Creates a new token message.
    pub fn new(recipient: H256, amount_or_id: U256, metadata: Vec<u8>) -> Self {
        Self {
            recipient,
            amount_or_id,
            metadata,
        }
    }

    /// The recipient of the token transfer.
    pub fn recipient(&self) -> H256 {
        self.recipient
    }

    /// The amount or ID of the token transfer.
    pub fn amount(&self) -> U256 {
        self.amount_or_id
    }

    /// The metadata of the token transfer.
    pub fn metadata(&self) -> &[u8] {
        &self.metadata
    }
}
