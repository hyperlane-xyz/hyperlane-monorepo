use base64::{
    engine::general_purpose::STANDARD as BASE64, prelude::BASE64_STANDARD_NO_PAD, Engine,
};
use once_cell::sync::Lazy;

/// The event attribute key for the contract address.
pub(crate) const CONTRACT_ADDRESS_ATTRIBUTE_KEY: &str = "_contract_address";
/// Base64 encoded version of the contract address attribute key, i.e.
pub(crate) static CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(CONTRACT_ADDRESS_ATTRIBUTE_KEY));

#[cfg(test)]
/// Helper function to create a Vec<EventAttribute> from a JSON string -
/// crate::payloads::general::EventAttribute has a Deserialize impl while
/// cosmrs::tendermint::abci::EventAttribute does not.
pub(crate) fn event_attributes_from_str(attrs_str: &str) -> Vec<cometbft::abci::EventAttribute> {
    serde_json::from_str::<Vec<crate::cw::payloads::general::EventAttribute>>(attrs_str)
        .unwrap()
        .into_iter()
        .map(|attr| attr.into())
        .collect()
}

use cometbft_rpc::endpoint::broadcast::tx_commit::Response;
use cosmrs::{crypto::PublicKey, proto, tx::SignerPublicKey, Any};
use crypto::decompress_public_key;
use serde::{Deserialize, Serialize};
use tracing::warn;

use hyperlane_core::{AccountAddressType, ChainResult, FixedPointNumber, TxOutcome, H256};

const INJECTIVE_PUBLIC_KEY_TYPE_URL: &str = "/injective.crypto.v1beta1.ethsecp256k1.PubKey";

use crate::HyperlaneCosmosError;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CosmosKeyJsonFormat {
    #[serde(rename = "@type")]
    pub key_type: &'static str,
    pub key: String,
}

pub fn normalize_public_key(
    signer_public_key: SignerPublicKey,
) -> ChainResult<(SignerPublicKey, AccountAddressType)> {
    let public_key_and_account_address_type = match signer_public_key {
        SignerPublicKey::Single(pk) => (SignerPublicKey::from(pk), AccountAddressType::Bitcoin),
        SignerPublicKey::LegacyAminoMultisig(pk) => {
            (SignerPublicKey::from(pk), AccountAddressType::Bitcoin)
        }
        SignerPublicKey::Any(pk) => {
            if pk.type_url != PublicKey::ED25519_TYPE_URL
                && pk.type_url != PublicKey::SECP256K1_TYPE_URL
                && pk.type_url != INJECTIVE_PUBLIC_KEY_TYPE_URL
            {
                let msg = format!(
                    "can only normalize public keys with a known TYPE_URL: {}, {}, {}",
                    PublicKey::ED25519_TYPE_URL,
                    PublicKey::SECP256K1_TYPE_URL,
                    INJECTIVE_PUBLIC_KEY_TYPE_URL
                );
                warn!(pk.type_url, msg);
                Err(HyperlaneCosmosError::PublicKeyError(msg.to_owned()))?
            }

            let (pub_key, account_address_type) = if pk.type_url == INJECTIVE_PUBLIC_KEY_TYPE_URL {
                let any = Any {
                    type_url: PublicKey::SECP256K1_TYPE_URL.to_owned(),
                    value: pk.value,
                };

                let proto: proto::cosmos::crypto::secp256k1::PubKey =
                    any.to_msg().map_err(Into::<HyperlaneCosmosError>::into)?;

                let decompressed = decompress_public_key(&proto.key)
                    .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;

                let cometbft_key = cometbft::PublicKey::from_raw_secp256k1(&decompressed)
                    .ok_or_else(|| {
                        HyperlaneCosmosError::PublicKeyError(
                            "cannot create cometbft public key".to_owned(),
                        )
                    })?;

                let cosm_key = cometbft_pubkey_to_cosmrs_pubkey(&cometbft_key)?;
                (cosm_key, AccountAddressType::Ethereum)
            } else {
                (PublicKey::try_from(pk)?, AccountAddressType::Bitcoin)
            };

            (SignerPublicKey::Single(pub_key), account_address_type)
        }
    };

    Ok(public_key_and_account_address_type)
}

pub fn cometbft_pubkey_to_cosmrs_pubkey(
    cometbft_key: &cometbft::PublicKey,
) -> ChainResult<cosmrs::crypto::PublicKey> {
    let cometbft_key_json = serde_json::to_string(&cometbft_key)
        .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;

    let cosmos_key_json = match cometbft_key {
        cometbft::PublicKey::Ed25519(key) => CosmosKeyJsonFormat {
            key_type: cosmrs::crypto::PublicKey::ED25519_TYPE_URL,
            key: BASE64_STANDARD_NO_PAD.encode(key.as_bytes()),
        },
        cometbft::PublicKey::Secp256k1(key) => CosmosKeyJsonFormat {
            key_type: cosmrs::crypto::PublicKey::SECP256K1_TYPE_URL,
            key: BASE64_STANDARD_NO_PAD.encode(key.to_sec1_bytes()),
        },
        // not sure why it requires me to have this extra arm. But
        // we should never reach this
        _ => {
            return Err(HyperlaneCosmosError::PublicKeyError("Invalid key".into()).into());
        }
    };

    let json_val = serde_json::to_string(&cosmos_key_json)
        .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;
    let cosm_key = PublicKey::from_json(&json_val)
        .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;
    Ok(cosm_key)
}

pub(crate) fn tx_response_to_outcome(response: Response, gas_price: FixedPointNumber) -> TxOutcome {
    TxOutcome {
        transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
        executed: response.check_tx.code.is_ok() && response.tx_result.code.is_ok(),
        gas_used: response.tx_result.gas_used.into(),
        gas_price,
    }
}
