//! The Hyperlane Token message format.

use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H256};

#[derive(Debug)]
pub struct AccountConfig {
    /// The account owner on the origin domain.
    owner: H256,
    /// The ISM to use on the destination domain.
    ism: H256,
    /// The salt to use for account derivation.
    salt: H256,
}

/// Message contents sent or received by a Hyperlane Interchain Account program
#[derive(Debug)]
pub struct InterchainAccountMessage {
    /// The kind of message. See solidity InterchainAccountMessage.sol
    kind: u8,
    pub account_config: AccountConfig,
    pub calls: Vec<u8>,
}

impl Encode for InterchainAccountMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write([self.kind].as_ref())?;

        writer.write_all(self.account_config.owner.as_ref())?;
        writer.write_all(self.account_config.ism.as_ref())?;
        writer.write_all(self.account_config.salt.as_ref())?;

        writer.write_all(&self.calls)?;

        Ok(32 + 32 + 32 + self.calls.len())
    }
}

impl Decode for InterchainAccountMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut kind_buf = [0_u8; 1];
        reader.read_exact(&mut kind_buf)?;
        let kind = kind_buf[0];

        let mut owner = H256::zero();
        reader.read_exact(owner.as_mut())?;

        let mut ism = H256::zero();
        reader.read_exact(ism.as_mut())?;

        let mut salt = H256::zero();
        reader.read_exact(salt.as_mut())?;

        let mut calls = vec![];
        reader.read_to_end(&mut calls)?;

        Ok(Self {
            kind,
            account_config: AccountConfig { owner, ism, salt },
            calls,
        })
    }
}

impl InterchainAccountMessage {
    /// Creates a new token message.
    pub fn new(owner: H256, ism: Option<H256>, salt: Option<H256>, calls: Vec<u8>) -> Self {
        Self {
            kind: 0,
            account_config: AccountConfig {
                owner,
                ism: ism.unwrap_or_default(),
                salt: salt.unwrap_or_default(),
            },
            calls,
        }
    }
}
