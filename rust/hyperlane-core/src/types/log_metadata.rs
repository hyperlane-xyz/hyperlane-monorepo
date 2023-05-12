use std::cmp::Ordering;

use ethers_contract::LogMeta as EthersLogMeta;
use serde::{Deserialize, Serialize};

use crate::{Decode, Encode, HyperlaneProtocolError, H256, U256};

/// A close clone of the Ethereum `LogMeta`, this is designed to be a more
/// generic metadata that we can use for other blockchains later. Some changes
/// may be required in the future.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogMeta {
    /// Address from which this log originated
    pub address: H256,

    /// The block in which the log was emitted
    pub block_number: u64,

    /// The block hash in which the log was emitted
    pub block_hash: H256,

    /// The transaction hash in which the log was emitted
    pub transaction_hash: H256,

    /// Transactions index position log was created from
    pub transaction_index: u64,

    /// Log index position in the block
    pub log_index: U256,
}

impl From<EthersLogMeta> for LogMeta {
    fn from(v: EthersLogMeta) -> Self {
        Self {
            address: v.address.into(),
            block_number: v.block_number.as_u64(),
            block_hash: v.block_hash,
            transaction_hash: v.transaction_hash,
            transaction_index: v.transaction_index.as_u64(),
            log_index: v.log_index,
        }
    }
}

impl From<&EthersLogMeta> for LogMeta {
    fn from(v: &EthersLogMeta) -> Self {
        Self {
            address: v.address.into(),
            block_number: v.block_number.as_u64(),
            block_hash: v.block_hash,
            transaction_hash: v.transaction_hash,
            transaction_index: v.transaction_index.as_u64(),
            log_index: v.log_index,
        }
    }
}

// note: this ordering assumes both logs are part of the same blockchain.
impl PartialOrd for LogMeta {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(match self.block_number.cmp(&other.block_number) {
            Ordering::Equal => self.log_index.cmp(&other.log_index),
            ord => ord,
        })
    }
}

impl Ord for LogMeta {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).unwrap()
    }
}

const LOG_META_LEN: usize = 32 + 8 + 32 + 32 + 8 + 32;

impl Encode for LogMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self.address.as_ref())?;
        writer.write_all(&self.block_number.to_be_bytes())?;
        writer.write_all(self.block_hash.as_ref())?;
        writer.write_all(self.transaction_hash.as_ref())?;
        writer.write_all(&self.transaction_index.to_be_bytes())?;
        writer.write_all(&self.log_index.to_be_bytes())?;
        Ok(LOG_META_LEN)
    }
}

impl Decode for LogMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut version = [0u8; 1];
        reader.read_exact(&mut version)?;

        let mut nonce = [0u8; 4];
        reader.read_exact(&mut nonce)?;

        let mut origin = [0u8; 4];
        reader.read_exact(&mut origin)?;

        let mut sender = H256::zero();
        reader.read_exact(sender.as_mut())?;

        let mut destination = [0u8; 4];
        reader.read_exact(&mut destination)?;

        let mut recipient = H256::zero();
        reader.read_exact(recipient.as_mut())?;

        let mut body = vec![];
        reader.read_to_end(&mut body)?;

        Ok(Self {
            version: u8::from_be_bytes(version),
            nonce: u32::from_be_bytes(nonce),
            origin: u32::from_be_bytes(origin),
            sender,
            destination: u32::from_be_bytes(destination),
            recipient,
            body,
        })
    }
}
