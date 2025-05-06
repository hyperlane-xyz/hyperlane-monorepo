use std::fmt::Debug;

use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;

use crate::payload::FullPayload;

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct EthereumTxPrecursor {
    pub tx: TypedTransaction,
    pub function: Function,
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

    pub fn from_payload(payload: &FullPayload) -> Self {
        use crate::chain_tx_adapter::chains::ethereum::payload::parse_data;

        let (tx, function) = parse_data(payload);
        EthereumTxPrecursor::new(tx, function)
    }
}
