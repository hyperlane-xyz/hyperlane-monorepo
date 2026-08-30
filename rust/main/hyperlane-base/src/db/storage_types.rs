use std::io::{Read, Write};

use hyperlane_core::{
    Decode, Encode, HyperlaneProtocolError, InterchainGasExpenditure, InterchainGasPayment,
    ReprepareReason, H256, U256,
};
use serde::{Deserialize, Serialize};

const PENDING_MESSAGE_RETRY_STATE_VERSION: u8 = 1;

/// Durable retry state for a pending message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingMessageRetryState {
    version: u8,
    /// Number of delivery attempts made.
    pub retry_count: u32,
    /// Absolute Unix timestamp for the next attempt.
    pub next_attempt_at_millis: Option<u64>,
    /// Original delay, used to bound backwards wall-clock skew.
    pub retry_delay_millis: Option<u64>,
    /// Retry reason used when the deadline was calculated.
    pub reason: Option<ReprepareReason>,
}

impl PendingMessageRetryState {
    /// Creates a versioned retry-state record.
    pub fn new(
        retry_count: u32,
        next_attempt_at_millis: Option<u64>,
        retry_delay_millis: Option<u64>,
        reason: Option<ReprepareReason>,
    ) -> Self {
        Self {
            version: PENDING_MESSAGE_RETRY_STATE_VERSION,
            retry_count,
            next_attempt_at_millis,
            retry_delay_millis,
            reason,
        }
    }
}

impl Encode for PendingMessageRetryState {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        #[allow(clippy::io_other_error)]
        let serialized = serde_json::to_vec(self)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::Other, "Failed to serialize"))?;
        writer.write(&serialized)
    }
}

impl Decode for PendingMessageRetryState {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        let state: Self = serde_json::from_reader(reader).map_err(|err| {
            #[allow(clippy::io_other_error)]
            HyperlaneProtocolError::IoError(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("Failed to deserialize retry state: {err}"),
            ))
        })?;
        if state.version != PENDING_MESSAGE_RETRY_STATE_VERSION
            || state.next_attempt_at_millis.is_some() != state.retry_delay_millis.is_some()
        {
            return Err(HyperlaneProtocolError::IoError(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Unsupported or inconsistent pending-message retry state",
            )));
        }
        Ok(state)
    }
}

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
