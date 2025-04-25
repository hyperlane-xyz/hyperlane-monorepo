use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

#[cfg(feature = "ethers")]
use ethers_contract::LogMeta as EthersLogMeta;

use crate::{Decode, Encode, HyperlaneProtocolError, H256, H512, U256};

/// A close clone of the Ethereum `LogMeta`, this is designed to be a more
/// generic metadata that we can use for other blockchains later. Some changes
/// may be required in the future.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default, Hash)]
pub struct LogMeta {
    /// Address from which this log originated
    pub address: H256,

    /// The block in which the log was emitted
    pub block_number: u64,

    /// The block hash in which the log was emitted
    pub block_hash: H256,

    /// The transaction identifier/hash in which the log was emitted
    pub transaction_id: H512,

    /// Transactions index position log was created from
    pub transaction_index: u64,

    /// Log index position in the block
    pub log_index: U256,
}

#[cfg(feature = "ethers")]
impl From<EthersLogMeta> for LogMeta {
    fn from(v: EthersLogMeta) -> Self {
        Self::from(&v)
    }
}

// Constants for byte lengths of fields
const ADDRESS_LEN: usize = 32;
const BLOCK_NUMBER_LEN: usize = 8;
const BLOCK_HASH_LEN: usize = 32;
const TRANSACTION_ID_LEN: usize = 64;
const TRANSACTION_INDEX_LEN: usize = 8;
const LOG_INDEX_LEN: usize = 32;
const LOG_META_LEN: usize = ADDRESS_LEN
    + BLOCK_NUMBER_LEN
    + BLOCK_HASH_LEN
    + TRANSACTION_ID_LEN
    + TRANSACTION_INDEX_LEN
    + LOG_INDEX_LEN; // 32 + 8 + 32 + 64 + 8 + 32 = 176

impl Encode for LogMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(self.address.as_ref())?;
        writer.write_all(&self.block_number.to_be_bytes())?;
        writer.write_all(self.block_hash.as_ref())?;
        writer.write_all(self.transaction_id.as_ref())?;
        writer.write_all(&self.transaction_index.to_be_bytes())?;
        let mut log_index_bytes = [0u8; LOG_INDEX_LEN];
        self.log_index.to_big_endian(&mut log_index_bytes);
        writer.write_all(&log_index_bytes)?;
        Ok(LOG_META_LEN)
    }
}

impl Decode for LogMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut address = H256::zero();
        reader.read_exact(address.as_mut())?;

        let mut block_number_bytes = [0u8; BLOCK_NUMBER_LEN];
        reader.read_exact(&mut block_number_bytes)?;

        let mut block_hash = H256::zero();
        reader.read_exact(block_hash.as_mut())?;

        let mut transaction_id = H512::zero();
        reader.read_exact(transaction_id.as_mut())?;

        let mut transaction_index_bytes = [0u8; TRANSACTION_INDEX_LEN];
        reader.read_exact(&mut transaction_index_bytes)?;

        let mut log_index_bytes = [0u8; LOG_INDEX_LEN];
        reader.read_exact(&mut log_index_bytes)?;

        Ok(Self {
            address,
            block_number: u64::from_be_bytes(block_number_bytes),
            block_hash,
            transaction_id,
            transaction_index: u64::from_be_bytes(transaction_index_bytes),
            log_index: U256::from_big_endian(&log_index_bytes),
        })
    }
}

#[cfg(feature = "ethers")]
impl From<&EthersLogMeta> for LogMeta {
    fn from(v: &EthersLogMeta) -> Self {
        Self {
            address: v.address.into(),
            block_number: v.block_number.as_u64(),
            block_hash: v.block_hash.into(),
            transaction_id: v.transaction_hash.into(),
            transaction_index: v.transaction_index.as_u64(),
            log_index: v.log_index.into(),
        }
    }
}

// note: this ordering assumes both logs are part of the same blockchain.
#[allow(clippy::non_canonical_partial_ord_impl)] // TODO: `rustc` 1.80.1 clippy issue
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

impl LogMeta {
    /// Create a new LogMeta with random transaction ID
    pub fn random() -> Self {
        Self {
            address: H256::zero(),
            block_number: 1,
            block_hash: H256::zero(),
            transaction_id: H512::random(),
            transaction_index: 0,
            log_index: U256::zero(),
        }
    }
}
