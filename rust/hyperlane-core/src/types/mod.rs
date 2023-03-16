pub use primitive_types::{H128, H160, H256, H512, U128, U256, U512};
use std::io::{Read, Write};
use std::ops::Add;

pub use announcement::*;
pub use chain_data::*;
pub use checkpoint::*;
pub use log_metadata::*;
pub use message::*;

use crate::{Decode, Encode, HyperlaneProtocolError};

mod announcement;
mod chain_data;
mod checkpoint;
mod log_metadata;
mod message;

/// Unified 32-byte identifier with convenience tooling for handling
/// 20-byte ids (e.g ethereum addresses)
pub mod identifiers;

/// A payment of a message's gas costs.
#[derive(Debug, Copy, Clone)]
pub struct InterchainGasPayment {
    /// The id of the message
    pub message_id: H256,
    /// The amount of native tokens paid.
    pub payment: U256,
    /// The amount of destination gas paid for.
    pub gas_amount: U256,
}

/// Amount of gas spent attempting to send the message.
#[derive(Debug, Copy, Clone)]
pub struct InterchainGasExpenditure {
    /// The id of the message
    pub message_id: H256,
    /// Amount of destination tokens used attempting to relay the message
    pub tokens_used: U256,
    /// Amount of destination gas used attempting to relay the message
    pub gas_used: U256,
}

impl Add for InterchainGasPayment {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        assert_eq!(
            self.message_id, rhs.message_id,
            "Cannot add interchain gas payments for different messages"
        );
        Self {
            message_id: self.message_id,
            payment: self.payment + rhs.payment,
            gas_amount: self.gas_amount + rhs.gas_amount,
        }
    }
}

impl Add for InterchainGasExpenditure {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        assert_eq!(
            self.message_id, rhs.message_id,
            "Cannot add interchain gas expenditures for different messages"
        );
        Self {
            message_id: self.message_id,
            tokens_used: self.tokens_used + rhs.tokens_used,
            gas_used: self.gas_used + rhs.gas_used,
        }
    }
}

/// Uniquely identifying metadata for an InterchainGasPayment
#[derive(Debug)]
pub struct InterchainGasPaymentMeta {
    /// The transaction hash in which the GasPayment log was emitted
    pub transaction_hash: H256,
    /// The index of the GasPayment log within the transaction's logs
    pub log_index: u64,
}

impl Encode for InterchainGasPaymentMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let mut written = 0;
        written += self.transaction_hash.write_to(writer)?;
        written += self.log_index.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for InterchainGasPaymentMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        Ok(Self {
            transaction_hash: H256::read_from(reader)?,
            log_index: u64::read_from(reader)?,
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
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TxCostEstimate {
    /// The gas limit for the transaction.
    pub gas_limit: U256,
    /// The gas price for the transaction.
    pub gas_price: U256,
    /// The rough estimation of the L2 gas for the transaction.
    /// Because getting an accurate estimation of L2 gas used isn't
    /// straightforward, this is intended to be an estimation and not
    /// a hard upper bound of L2 gas.
    /// If Some, `gas_limit` is the sum of the gas limit
    /// covering L1 costs and the L2 gas estimation.
    /// Only present for Arbitrum Nitro chains, where the gas amount
    /// is used to cover L1 and L2 costs. For details:
    /// https://medium.com/offchainlabs/understanding-arbitrum-2-dimensional-fees-fd1d582596c9
    pub l2_gas_estimate: Option<U256>,
}

impl TxCostEstimate {
    /// The gas limit to be used by gas enforcement policies.
    pub fn enforceable_gas_limit(&self) -> U256 {
        self.l2_gas_estimate.unwrap_or(self.gas_limit)
    }
}
