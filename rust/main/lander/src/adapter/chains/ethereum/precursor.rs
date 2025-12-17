use std::fmt::Debug;

use super::gas_price::GasPrice;
use crate::payload::{FullPayload, PayloadDetails};
use crate::transaction::VmSpecificTxData;
use ethers::{
    abi::Function,
    types::{transaction::eip2718::TypedTransaction, H160},
};
use ethers_core::types::transaction::eip2718::TypedTransaction::{Eip1559, Eip2930, Legacy};

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct EthereumTxPrecursor {
    pub tx: TypedTransaction,
    pub function: Function,
}

impl Debug for EthereumTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let gas_price = self.extract_gas_price();
        let tx_type = self.extract_transaction_type();
        f.debug_struct("EthereumTxPrecursor")
            .field("tx.type", &tx_type)
            .field("tx.from", &self.tx.from())
            .field("tx.to", &self.tx.to())
            .field("tx.nonce", &self.tx.nonce())
            .field("tx.gas_limit", &self.tx.gas())
            .field("tx.gas_price", &gas_price)
            .field("tx.chain_id", &self.tx.chain_id())
            .field("tx.value", &self.tx.value())
            .field("function.name", &self.function.name)
            .finish()
    }
}

impl PartialEq for EthereumTxPrecursor {
    fn eq(&self, other: &Self) -> bool {
        self.tx == other.tx
            && self.function.name == other.function.name
            && self.function.inputs == other.function.inputs
            && self.function.outputs == other.function.outputs
            && self.function.state_mutability == other.function.state_mutability
    }
}

impl Eq for EthereumTxPrecursor {}

impl From<EthereumTxPrecursor> for VmSpecificTxData {
    fn from(value: EthereumTxPrecursor) -> Self {
        VmSpecificTxData::Evm(Box::new(value))
    }
}

impl EthereumTxPrecursor {
    pub fn new(tx: TypedTransaction, function: Function) -> Self {
        Self { tx, function }
    }

    pub fn from_payload(payload: &FullPayload, signer: H160) -> Self {
        use super::payload::parse_data;

        let (mut tx, function) = parse_data(payload);
        tx.set_from(signer);

        EthereumTxPrecursor::new(tx, function)
    }

    pub fn from_success_criteria(details: &PayloadDetails, signer: H160) -> Option<Self> {
        use super::payload::parse_success_criteria;

        let (mut tx, function) = parse_success_criteria(details)?;
        tx.set_from(signer);

        Some(EthereumTxPrecursor::new(tx, function))
    }

    pub fn extract_gas_price(&self) -> GasPrice {
        match &self.tx {
            Legacy(r) => match r.gas_price {
                Some(gas_price) => GasPrice::NonEip1559 {
                    gas_price: gas_price.into(),
                },
                None => GasPrice::None,
            },
            Eip2930(r) => match r.tx.gas_price {
                Some(gas_price) => GasPrice::NonEip1559 {
                    gas_price: gas_price.into(),
                },
                None => GasPrice::None,
            },
            Eip1559(r) => match (r.max_fee_per_gas, r.max_priority_fee_per_gas) {
                (Some(max_fee), Some(max_priority_fee)) => GasPrice::Eip1559 {
                    max_fee: max_fee.into(),
                    max_priority_fee: max_priority_fee.into(),
                },
                _ => GasPrice::None,
            },
        }
    }

    pub fn extract_transaction_type(&self) -> String {
        match &self.tx {
            Legacy(_) => "legacy".to_string(),
            Eip2930(_) => "eip2930".to_string(),
            Eip1559(_) => "eip1559".to_string(),
        }
    }
}
