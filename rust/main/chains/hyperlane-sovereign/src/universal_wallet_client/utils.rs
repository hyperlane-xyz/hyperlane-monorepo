use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, Encode, HyperlaneMessage, SignedType, H256,
};
use serde_json::{json, Value};

use crate::universal_wallet_client::UniversalClient;

pub async fn get_simulate_json_query(
    message: &HyperlaneMessage,
    metadata: &[u8],
    client: &UniversalClient,
) -> ChainResult<Value> {
    let call_message = json!({
        "mailbox": {
            "process": {
                "metadata": metadata.to_vec(),
                "message": message.to_vec(),
            }
        },
    });

    let encoded_call_message = client
        .encoded_call_message(&call_message)
        .await
        .map_err(|e| ChainCommunicationError::CustomError(format!("{e:?}")))?;

    let res = json!(
        {
            "body":{
                "details":{
                    "chain_id":message.destination,
                    "max_fee":"100000000",
                    "max_priority_fee_bips":0
                },
                "encoded_call_message":encoded_call_message,
                "nonce":message.nonce,
                "generation":0, // get _generation
                "sender_pub_key": "\"f8ad2437a279e1c8932c07358c91dc4fe34864a98c6c25f298e2a0199c1509ff\""
            }
        }
    );
    Ok(res)
}

pub async fn announce_validator(
    announcement: SignedType<Announcement>,
    client: &UniversalClient,
) -> ChainResult<H256> {
    let sig_hyperlane = announcement.signature;
    let sig_bytes: [u8; 65] = sig_hyperlane.into();
    let call_message = json!({
        "mailbox": {
            "announce": {
                "validator_address": announcement.value.validator,
                "storage_location": announcement.value.storage_location,
                "signature": format!("0x{}", hex::encode(sig_bytes)),
            }
        },
    });

    let res = client
        .build_and_submit(call_message)
        .await
        .map_err(|e| ChainCommunicationError::CustomError(format!("{e:?}")))?;

    Ok(res.0)
}
