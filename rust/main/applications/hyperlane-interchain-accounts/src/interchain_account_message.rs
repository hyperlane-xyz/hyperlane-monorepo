//! The Hyperlane Token message format.

use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H256};

/// Message contents sent or received by a Hyperlane Interchain Account program
#[derive(Debug)]
pub struct InterchainAccountMessage {
    owner: H256,
    ism: H256,
    salt: H256,
    calls: Vec<u8>,
}

impl Encode for InterchainAccountMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
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
        let mut owner = H256::zero();
        reader.read_exact(owner.as_mut())?;

        let mut ism = H256::zero();
        reader.read_exact(ism.as_mut())?;

        let mut salt = H256::zero();
        reader.read_exact(salt.as_mut())?;

        let mut calls = vec![];
        reader.read_to_end(&mut calls)?;

        Ok(Self {
            owner,
            ism,
            salt,
            calls,
        })
    }
}

impl InterchainAccountMessage {
    /// Creates a new token message.
    pub fn new(owner: H256, ism: H256, salt: H256, calls: Vec<u8>) -> Self {
        Self {
            owner,
            ism,
            salt,
            calls,
        }
    }
}
