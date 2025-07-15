use ethers::{abi::Function, types::transaction::eip2718::TypedTransaction};

use crate::{payload::PayloadDetails, FullPayload};

pub fn parse_data(payload: &FullPayload) -> (TypedTransaction, Function) {
    parse(&payload.data).expect(
        "Payload should contain tuple of TypedTransaction and Function for Ethereum as data",
    )
}

pub fn parse_success_criteria(
    payload_details: &PayloadDetails,
) -> Option<(TypedTransaction, Function)> {
    payload_details
        .success_criteria
        .as_ref()
        .map(|data| parse(data))
        .map(|r| {
            r.expect("Payload should contain tuple of TypedTransaction and Function for Ethereum as success criteria")
        })
}

fn parse(data: &[u8]) -> serde_json::Result<(TypedTransaction, Function)> {
    serde_json::from_slice::<(TypedTransaction, Function)>(data)
}
