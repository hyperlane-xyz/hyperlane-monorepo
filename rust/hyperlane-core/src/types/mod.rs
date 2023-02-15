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
/// TODO: should we merge this with the gas payments?
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

/// Uniquely identifying metadata for a transaction
#[derive(Debug)]
pub struct TxMeta {
    /// The transaction hash in which the GasPayment log was emitted
    pub transaction_hash: H256,
    /// The index of log within the transaction's logs
    pub log_index: u64,
}

impl Encode for TxMeta {
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

impl Decode for TxMeta {
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
    pub meta: TxMeta,
}

/// A gas expense from submitting a transaction.
#[derive(Debug)]
pub struct GasExpenditureWithMeta {
    /// The InterchainGasExpenditure
    pub payment: InterchainGasExpenditure,
    /// Metadata for the expenditure
    pub meta: TxMeta,
}

/// A cost estimate for a transaction.
#[derive(Clone, Debug, Default)]
pub struct TxCostEstimate {
    /// The gas limit for the transaction.
    pub gas_limit: U256,
    /// The gas price for the transaction.
    pub gas_price: U256,
}
