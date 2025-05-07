use crate::FullPayload;
use ethers::abi::Function;
use ethers::types::transaction::eip2718::TypedTransaction;

pub fn parse_data(payload: &FullPayload) -> (TypedTransaction, Function) {
    serde_json::from_slice::<(TypedTransaction, Function)>(&payload.data)
        .expect("Payload should contain tuple of TypedTransaction and Function for Ethereum")
}
