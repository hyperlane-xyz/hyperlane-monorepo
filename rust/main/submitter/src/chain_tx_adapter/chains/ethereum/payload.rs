use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;

use crate::payload::FullPayload;

pub(crate) trait Precursor {
    fn precursor(&self) -> (TypedTransaction, Function);
}

impl Precursor for FullPayload {
    fn precursor(&self) -> (TypedTransaction, Function) {
        serde_json::from_slice::<(TypedTransaction, Function)>(&self.data)
            .expect("Payload should contain tuple of TypedTransaction and Function for Ethereum")
    }
}
