//! TODO

use hyperlane_core::{Decode, Encode, H256, HyperlaneError, U256};
use solana_program::pubkey::Pubkey;

/// Message body of Hyperlane protocol messages for Warp Routes.
#[derive(Debug)]
pub struct Message {
    pub recipient: H256,
    pub amount_or_token_id: U256, // ERC721 uses this as id not amount
    pub metadata: Vec<u8>,
}

impl Message {
    pub fn recipient_pubkey(&self) -> Result<Pubkey, crate::error::Error> {
        self.recipient
            .as_bytes()
            .try_into()
            .map_err(|_| crate::error::Error::TODO)
            .map(Pubkey::new_from_array)
    }
}

impl Encode for Message {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write
    {
        let mut written = 0;
        written += self.recipient.write_to(writer)?;
        written += self.amount_or_token_id.write_to(writer)?;
        writer.write_all(self.metadata.as_ref())?;
        written += self.metadata.len();
        Ok(written)
    }
}

impl Decode for Message {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneError>
    where
        R: std::io::Read,
        Self: Sized
    {
        let recipient = H256::read_from(reader)?;
        let amount_or_token_id = U256::read_from(reader)?;
        let mut metadata = vec![];
        reader.read_to_end(&mut metadata)?;
        Ok(Message {
            recipient,
            amount_or_token_id,
            metadata
        })
    }
}
