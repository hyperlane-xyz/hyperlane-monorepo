use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

#[cfg(feature = "ethers")]
use ethers_contract::LogMeta as EthersLogMeta;

use crate::{H256, H512, U256};

/// A close clone of the Ethereum `LogMeta`, this is designed to be a more
/// generic metadata that we can use for other blockchains later. Some changes
/// may be required in the future.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
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
