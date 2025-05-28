use std::fmt::Debug;

use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::{abi::Function, types::H160};

use crate::payload::{FullPayload, PayloadDetails};

#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct EthereumTxPrecursor {
    pub tx: TypedTransaction,
    pub function: Function,
}

impl Debug for EthereumTxPrecursor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EthereumTxPrecursor")
            .field("tx.from", &self.tx.from())
            .field("tx.to", &self.tx.to())
            .field("tx.nonce", &self.tx.nonce())
            .field("tx.gas_limit", &self.tx.gas())
            .field("tx.gas_price", &self.tx.gas_price())
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

    pub fn from_success_criteria(details: &PayloadDetails) -> Option<Self> {
        use super::payload::parse_success_criteria;

        parse_success_criteria(details).map(|(tx, function)| EthereumTxPrecursor::new(tx, function))
    }
}
