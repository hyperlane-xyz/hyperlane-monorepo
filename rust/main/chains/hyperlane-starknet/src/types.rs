use cainome::cairo_serde::U256 as StarknetU256;
use hyperlane_core::{ChainResult, TxOutcome, H256, U256};
use starknet::core::types::{
    ExecutionResult, FieldElement, FromByteArrayError, FromStrError, InvokeTransactionReceipt,
    ValueOutOfRangeError,
};

pub struct HyH256(pub H256);
pub struct HyU256(pub U256);

impl From<FieldElement> for HyH256 {
    fn from(val: FieldElement) -> Self {
        HyH256(H256::from_slice(val.to_bytes_be().as_slice()))
    }
}

impl TryInto<FieldElement> for HyH256 {
    type Error = FromByteArrayError;
    fn try_into(self) -> Result<FieldElement, Self::Error> {
        FieldElement::from_bytes_be(&self.0.to_fixed_bytes())
    }
}

impl TryFrom<(FieldElement, FieldElement)> for HyH256 {
    type Error = ValueOutOfRangeError;
    fn try_from(val: (FieldElement, FieldElement)) -> Result<HyH256, Self::Error> {
        let value: StarknetU256 = val.try_into()?;
        Ok(HyH256(H256::from_slice(value.to_bytes_be().as_slice())))
    }
}

impl From<FieldElement> for HyU256 {
    fn from(val: FieldElement) -> Self {
        HyU256(U256::from_big_endian(val.to_bytes_be().as_slice()))
    }
}

impl TryFrom<(FieldElement, FieldElement)> for HyU256 {
    type Error = ValueOutOfRangeError;
    fn try_from(val: (FieldElement, FieldElement)) -> Result<HyU256, Self::Error> {
        let value: StarknetU256 = val.try_into()?;
        Ok(HyU256(U256::from_big_endian(&value.to_bytes_be())))
    }
}

impl TryInto<FieldElement> for HyU256 {
    type Error = FromStrError;
    fn try_into(self) -> Result<FieldElement, Self::Error> {
        FieldElement::from_dec_str(&self.0.to_string())
    }
}

pub fn tx_receipt_to_outcome(receipt: InvokeTransactionReceipt) -> ChainResult<TxOutcome> {
    Ok(TxOutcome {
        transaction_id: H256::from_slice(receipt.transaction_hash.to_bytes_be().as_slice()).into(),
        executed: receipt.execution_result == ExecutionResult::Succeeded,
        gas_used: U256::from_big_endian(receipt.actual_fee.amount.to_bytes_be().as_slice()),
        gas_price: U256::one().try_into()?,
    })
}
