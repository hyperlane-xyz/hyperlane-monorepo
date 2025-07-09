use cainome::cairo_serde::{ValueOutOfRangeError, U256 as StarknetU256};
use hyperlane_core::{ChainResult, TxOutcome, H256, U256};
use starknet::core::types::{ExecutionResult, Felt, FromStrError, InvokeTransactionReceipt};

pub struct HyH256(pub H256);
pub struct HyU256(pub U256);

impl From<Felt> for HyH256 {
    fn from(val: Felt) -> Self {
        HyH256(H256::from_slice(val.to_bytes_be().as_slice()))
    }
}

impl From<HyH256> for Felt {
    fn from(value: HyH256) -> Self {
        Felt::from_bytes_be(&value.0.to_fixed_bytes())
    }
}

impl TryFrom<(Felt, Felt)> for HyH256 {
    type Error = ValueOutOfRangeError;
    fn try_from(val: (Felt, Felt)) -> Result<HyH256, Self::Error> {
        let value: StarknetU256 = val.try_into()?;
        Ok(HyH256(H256::from_slice(value.to_bytes_be().as_slice())))
    }
}

impl From<Felt> for HyU256 {
    fn from(val: Felt) -> Self {
        HyU256(U256::from_big_endian(val.to_bytes_be().as_slice()))
    }
}

impl TryFrom<(Felt, Felt)> for HyU256 {
    type Error = ValueOutOfRangeError;
    fn try_from(val: (Felt, Felt)) -> Result<HyU256, Self::Error> {
        let value: StarknetU256 = val.try_into()?;
        Ok(HyU256(U256::from_big_endian(&value.to_bytes_be())))
    }
}

impl TryInto<Felt> for HyU256 {
    type Error = FromStrError;
    fn try_into(self) -> Result<Felt, Self::Error> {
        Felt::from_dec_str(&self.0.to_string())
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
