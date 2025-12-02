use solana_sdk::pubkey::Pubkey as SealevelPubkey;

use crate::payload::PayloadDetails;

pub(crate) fn processed_account(payload_details: &PayloadDetails) -> Option<SealevelPubkey> {
    payload_details
        .success_criteria
        .as_ref()
        .map(|data| serde_json::from_slice::<SealevelPubkey>(data))
        .map(|r| {
            r.expect("Payload should contain a serialised Pubkey of an account which exists if the payload was successfully executed on chain as success criteria.")
        })
}
