use ethers::types::{H256, U256};

mod checkpoint;
mod log_metadata;
mod message;
mod provider_data;

/// Unified 32-byte identifier with convenience tooling for handling
/// 20-byte ids (e.g ethereum addresses)
pub mod identifiers;

pub use checkpoint::*;
pub use log_metadata::*;
pub use message::*;
pub use provider_data::*;

use crate::{AbacusError, Decode, Encode};

/// A payment of Outbox native tokens for a message
#[derive(Debug)]
pub struct InterchainGasPayment {
    /// The index of the message's leaf in the merkle tree
    pub leaf_index: u32,
    /// The payment amount, in Outbox native token wei
    pub amount: U256,
}

/// Uniquely identifying metadata for an InterchainGasPayment
#[derive(Debug)]
pub struct InterchainGasPaymentMeta {
    /// The transaction hash in which the GasPayment log was emitted
    pub transaction_hash: H256,
    /// The index of the GasPayment log within the transaction's logs
    pub log_index: U256,
}

impl Encode for InterchainGasPaymentMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        let mut written = 0;
        written += self.transaction_hash.write_to(writer)?;
        written += self.log_index.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for InterchainGasPaymentMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, AbacusError>
    where
        R: std::io::Read,
        Self: Sized,
    {
        Ok(Self {
            transaction_hash: H256::read_from(reader)?,
            log_index: U256::read_from(reader)?,
        })
    }
}

/// An InterchainGasPayment with metadata to uniquely identify the payment
#[derive(Debug)]
pub struct InterchainGasPaymentWithMeta {
    /// The InterchainGasPayment
    pub payment: InterchainGasPayment,
    /// Metadata for the payment
    pub meta: InterchainGasPaymentMeta,
}

/// A cost estimate for a transaction.
#[derive(Clone, Debug)]
pub struct TxCostEstimate {
    /// The gas limit for the transaction.
    pub gas_limit: U256,
    /// The gas price for the transaction.
    pub gas_price: U256,
}
