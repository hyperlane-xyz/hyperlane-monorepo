use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
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
pub(crate) fn event_attributes_from_str(
    attrs_str: &str,
) -> Vec<cosmrs::tendermint::abci::EventAttribute> {
    serde_json::from_str::<Vec<crate::cw::payloads::general::EventAttribute>>(attrs_str)
        .unwrap()
        .into_iter()
        .map(|attr| attr.into())
        .collect()
}

use cosmrs::{crypto::PublicKey, proto, tx::SignerPublicKey, Any};
use crypto::decompress_public_key;
use tendermint_rpc::endpoint::broadcast::tx_commit::Response;
use tracing::warn;

use hyperlane_core::{AccountAddressType, ChainResult, FixedPointNumber, TxOutcome, H256};

const INJECTIVE_PUBLIC_KEY_TYPE_URL: &str = "/injective.crypto.v1beta1.ethsecp256k1.PubKey";

use crate::HyperlaneCosmosError;

/// Normalizes the public key to a known format
pub(crate) fn normalize_public_key(
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

                let tendermint = tendermint::PublicKey::from_raw_secp256k1(&decompressed)
                    .ok_or_else(|| {
                        HyperlaneCosmosError::PublicKeyError(
                            "cannot create tendermint public key".to_owned(),
                        )
                    })?;

                (PublicKey::from(tendermint), AccountAddressType::Ethereum)
            } else {
                (PublicKey::try_from(pk)?, AccountAddressType::Bitcoin)
            };

            (SignerPublicKey::Single(pub_key), account_address_type)
        }
    };

    Ok(public_key_and_account_address_type)
}

pub(crate) fn tx_response_to_outcome(response: Response, gas_price: FixedPointNumber) -> TxOutcome {
    // TODO: check if gas price is the literal price per gas unit or how much we paid in tokens for gas
    // rn we assume that the underlying cosmos chain does not have gas refunds
    // in that case the gas paid will always be:
    // gas_wanted * gas_price
    let gas_price = FixedPointNumber::from(response.tx_result.gas_wanted) * gas_price;

    TxOutcome {
        transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
        executed: response.check_tx.code.is_ok() && response.tx_result.code.is_ok(),
        gas_used: response.tx_result.gas_used.into(),
        gas_price,
    }
}
