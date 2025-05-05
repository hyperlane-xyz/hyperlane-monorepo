//! The Hyperlane Token message format.

use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H256};

/// Message contents sent or received by a Hyperlane Interchain Account program
#[derive(Debug)]
pub struct InterchainAccountMessage {
    kind: u8,
    pub owner: H256,
    pub ism: H256,
    pub salt: H256,
    pub calls: Vec<u8>,
}

impl Encode for InterchainAccountMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let n = writer.write([self.kind].as_ref())?;
        assert_eq!(n, 1, "Wrote {} bytes, expected 1", n);

        writer.write_all(self.owner.as_ref())?;
        writer.write_all(self.ism.as_ref())?;
        writer.write_all(self.salt.as_ref())?;

        writer.write_all(&self.calls)?;

        Ok(32 + 32 + 32 + self.calls.len())
    }
}

impl Decode for InterchainAccountMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut kind = [0_u8; 1];
        reader.read_exact(&mut kind)?;

        let mut owner = H256::zero();
        reader.read_exact(owner.as_mut())?;

        let mut ism = H256::zero();
        reader.read_exact(ism.as_mut())?;

        let mut salt = H256::zero();
        reader.read_exact(salt.as_mut())?;

        let mut calls = vec![];
        reader.read_to_end(&mut calls)?;

        Ok(Self {
            kind: kind[0],
            owner,
            ism,
            salt,
            calls,
        })
    }
}

impl InterchainAccountMessage {
    /// Creates a new token message.
    pub fn new(owner: H256, ism: Option<H256>, salt: Option<H256>, calls: Vec<u8>) -> Self {
        Self {
            kind: 0,
            owner,
            ism: ism.unwrap_or_default(),
            salt: salt.unwrap_or_default(),
            calls,
        }
    }
}
