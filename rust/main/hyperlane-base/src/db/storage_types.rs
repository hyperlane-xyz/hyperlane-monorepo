use std::io::{Read, Write};

use hyperlane_core::{
    Decode, Encode, HyperlaneProtocolError, InterchainGasExpenditure, InterchainGasPayment, H256,
    U256,
};

/// Subset of `InterchainGasPayment` excluding the message id which is stored in
/// the key.
#[derive(Debug, Copy, Clone)]
pub struct InterchainGasPaymentData {
    /// The amount of tokens paid for the gas.
    pub payment: U256,
    /// The amount of gas paid for.
    pub gas_amount: U256,
}

/// Subset of `InterchainGasExpenditure` excluding the message id which is
/// stored in the key.
#[allow(missing_docs)]
#[derive(Debug, Copy, Clone)]
pub struct InterchainGasExpenditureData {
    pub tokens_used: U256,
    pub gas_used: U256,
}

impl Default for InterchainGasPaymentData {
    fn default() -> Self {
        Self {
            payment: U256::zero(),
            gas_amount: U256::zero(),
        }
    }
}

impl InterchainGasPaymentData {
    /// Complete the data with the message id and destination.
    pub fn complete(self, message_id: H256, destination: u32) -> InterchainGasPayment {
        InterchainGasPayment {
            message_id,
            destination,
            payment: self.payment,
            gas_amount: self.gas_amount,
        }
    }
}

impl From<InterchainGasPayment> for InterchainGasPaymentData {
    fn from(p: InterchainGasPayment) -> Self {
        Self {
            payment: p.payment,
            gas_amount: p.gas_amount,
        }
    }
}

impl Encode for InterchainGasPaymentData {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let written = self
            .payment
            .write_to(writer)?
            .saturating_add(self.gas_amount.write_to(writer)?);
        Ok(written)
    }
}

impl Decode for InterchainGasPaymentData {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        Ok(Self {
            payment: U256::read_from(reader)?,
            gas_amount: U256::read_from(reader)?,
        })
    }
}

impl Default for InterchainGasExpenditureData {
    fn default() -> Self {
        Self {
            tokens_used: U256::zero(),
            gas_used: U256::zero(),
        }
    }
}

impl InterchainGasExpenditureData {
    /// Complete the data with the message id.
    pub fn complete(self, message_id: H256) -> InterchainGasExpenditure {
        InterchainGasExpenditure {
            message_id,
            tokens_used: self.tokens_used,
            gas_used: self.gas_used,
        }
    }
}

impl From<InterchainGasExpenditure> for InterchainGasExpenditureData {
    fn from(p: InterchainGasExpenditure) -> Self {
        Self {
            tokens_used: p.tokens_used,
            gas_used: p.gas_used,
        }
    }
}

impl Encode for InterchainGasExpenditureData {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let written = self
            .tokens_used
            .write_to(writer)?
            .saturating_add(self.gas_used.write_to(writer)?);
        Ok(written)
    }
}

impl Decode for InterchainGasExpenditureData {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        Ok(Self {
            tokens_used: U256::read_from(reader)?,
            gas_used: U256::read_from(reader)?,
        })
    }
}
