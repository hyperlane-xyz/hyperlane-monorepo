#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
use async_trait::async_trait;
use cache_types::SerializedOffchainLookup;
use derive_more::Deref;
use derive_new::new;
use ethers::{abi::AbiDecode, core::utils::hex::decode as hex_decode, types::H160};
use hyperlane_base::cache::FunctionCallCache;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha3::{digest::Update, Digest, Keccak256};
use tracing::{info, instrument, warn};

use hyperlane_core::{
    utils::bytes_to_hex, CcipReadIsm, HyperlaneMessage, HyperlaneSignerExt, RawHyperlaneMessage,
    Signable, H256,
};
use hyperlane_ethereum::{OffchainLookup, Signers};

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    message_builder::MessageMetadataBuilder,
    Metadata, MetadataBuilder,
};

mod cache_types;

#[derive(Serialize, Deserialize)]
struct OffchainResponse {
    data: String,
}

#[derive(Clone, Debug, new, Deref)]
pub struct CcipReadIsmMetadataBuilder {
    base: MessageMetadataBuilder,
}

/// A Hyperlane (checkpoint, messageId) tuple
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize, Debug)]
pub struct HyperlaneOffchainLookupAttestation {
    message_id: H256,
    ism_address: H256,
    sender: H256,
    call_data: Vec<u8>,
}

impl Signable for HyperlaneOffchainLookupAttestation {
    /// A hash of the checkpoint contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    fn signing_hash(&self) -> H256 {
        // sign:
        // domain_hash(mailbox_address, mailbox_domain) || root || index (as u32) || message_id
        H256::from_slice(
            Keccak256::new()
                .chain(b"HYPERLANE_OFFCHAINLOOKUP")
                .chain(self.ism_address)
                .chain(self.sender)
                .chain(self.call_data.as_slice())
                .finalize()
                .as_slice(),
        )
    }
}

impl CcipReadIsmMetadataBuilder {
    /// Generate a relayer authentication signature (EIP-191) over call_data and sender.
    async fn generate_signature_hex(
        signer: &Signers,
        info: &OffchainLookup,
        message: &HyperlaneMessage,
        ism_address: H256,
    ) -> Result<String, MetadataBuildError> {
        // Derive the hash over call_data and sender
        let signable = HyperlaneOffchainLookupAttestation {
            message_id: message.id(),
            ism_address,
            call_data: info.call_data.clone().to_vec(),
            sender: info.sender.into(),
        };
        // EIP-191 compliant signature over the signing hash of the HyperlaneOffchainLookupAttestation.
        let signed = signer
            .sign(signable)
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))?;

        let sig_bytes: [u8; 65] = signed.signature.into();
        let sig_hex = bytes_to_hex(&sig_bytes);

        Ok(sig_hex)
    }

    /// Returns info on how to query for offchain information
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from the ISM contract. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `get_offchain_verify_info` matches
    /// the name of the method `get_offchain_verify_info`.
    async fn call_get_offchain_verify_info(
        &self,
        ism: Box<dyn CcipReadIsm>,
        message: &HyperlaneMessage,
    ) -> Result<OffchainLookup, MetadataBuildError> {
        let ism_domain = ism.domain().name();
        let fn_key = "get_offchain_verify_info";
        // To have the cache key be more succinct, we use the message id
        let call_params = (ism.address(), message.id());

        let info_from_cache = self
            .base
            .base_builder()
            .cache()
            .get_cached_call_result::<SerializedOffchainLookup>(ism_domain, fn_key, &call_params)
            .await
            .map_err(|err| {
                warn!(error = %err, "Error when caching call result for {:?}", fn_key);
            })
            .ok()
            .flatten();

        let info: OffchainLookup = match info_from_cache {
            Some(info) => info.into(),
            None => {
                let response = ism
                    .get_offchain_verify_info(RawHyperlaneMessage::from(message).to_vec())
                    .await;

                match response {
                    Ok(_) => {
                        info!("incorrectly configured getOffchainVerifyInfo, expected revert");
                        return Err(MetadataBuildError::CouldNotFetch);
                    }
                    Err(raw_error) => {
                        let matching_regex = Regex::new(r"0x[[:xdigit:]]+")
                            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
                        if let Some(matching) = &matching_regex.captures(&raw_error.to_string()) {
                            let hex_val = hex_decode(&matching[0][2..]).map_err(|err| {
                                MetadataBuildError::FailedToBuild(err.to_string())
                            })?;
                            OffchainLookup::decode(hex_val)
                                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
                        } else {
                            info!(?raw_error, "unable to parse custom error out of revert");
                            return Err(MetadataBuildError::CouldNotFetch);
                        }
                    }
                }
            }
        };

        self.base
            .base_builder()
            .cache()
            .cache_call_result(
                ism_domain,
                fn_key,
                &call_params,
                &SerializedOffchainLookup::from(info.clone()),
            )
            .await
            .map_err(|err| {
                warn!(error = %err, "Error when caching call result for {:?}", fn_key);
            })
            .ok();

        Ok(info)
    }
}

#[async_trait]
impl MetadataBuilder for CcipReadIsmMetadataBuilder {
    #[instrument(err, skip(self, message, _params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let ism = self
            .base
            .base_builder()
            .build_ccip_read_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        let info = self.call_get_offchain_verify_info(ism, message).await?;

        // Compute relayer authentication signature via EIP-191
        let maybe_signature_hex = if let Some(signer) = self.base.base_builder().get_signer() {
            Some(Self::generate_signature_hex(&signer, &info, message, ism_address).await?)
        } else {
            None
        };

        for url in info.urls.iter() {
            // Need to explicitly convert the sender H160 the hex because the `ToString` implementation
            // for `H160` truncates the output. (e.g. `0xc66a…7b6f` instead of returning
            // the full address)
            let sender_as_bytes = &bytes_to_hex(info.sender.as_bytes());
            let data_as_bytes = &info.call_data.to_string();
            let interpolated_url = url
                .replace("{sender}", sender_as_bytes)
                .replace("{data}", data_as_bytes);
            let res = if !url.contains("{data}") {
                let mut body = json!({
                    "sender": sender_as_bytes,
                    "data": data_as_bytes
                });
                if let Some(signature_hex) = &maybe_signature_hex {
                    body["signature"] = json!(signature_hex);
                }
                Client::new()
                    .post(interpolated_url)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
            } else {
                reqwest::get(interpolated_url)
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
            };

            let json: Result<OffchainResponse, reqwest::Error> = res.json().await;

            match json {
                Ok(result) => {
                    // remove leading 0x which hex_decode doesn't like
                    let metadata = hex_decode(&result.data[2..])
                        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
                    return Ok(Metadata::new(metadata));
                }
                Err(_err) => {
                    // try the next URL
                }
            }
        }

        // No metadata endpoints or endpoints down
        Err(MetadataBuildError::CouldNotFetch)
    }
}

mod test {
    use std::{str::FromStr, vec};

    use ethers::types::H160;
    use hyperlane_core::SignedType;

    use super::*;

    #[tokio::test]
    async fn test_generate_signature_hex() {
        // $ cast wallet new
        // Successfully created new keypair.
        // Address:     0xf9BC1b491f14d457Ee935AC0B7E2044B1DDFAc91
        // Private key: 0x35873ad2f7722ec6bde58404d23a3dbbd5e2534e7252c0623c6ec0651f15a0ce
        let signer = Signers::Local(
            ethers::signers::Wallet::from_str(
                "35873ad2f7722ec6bde58404d23a3dbbd5e2534e7252c0623c6ec0651f15a0ce",
            )
            .unwrap(),
        );
        let ism_address = H256::random();
        let info = OffchainLookup {
            call_data: vec![1, 2, 3].into(),
            sender: H160::zero(),
            urls: vec!["http://example.com".to_string()],
            callback_function: [1, 2, 3, 4],
            extra_data: vec![4, 5, 6].into(),
        };
        let message = HyperlaneMessage::default();

        let signature_hex = CcipReadIsmMetadataBuilder::generate_signature_hex(
            &signer,
            &info,
            &message,
            ism_address,
        )
        .await
        .unwrap();

        // 65 bytes = 130 hex chars + 2 for 0x
        assert_eq!(signature_hex.len(), 132);
        assert_eq!(
            signature_hex,
            "0x16a3dcb2c286ae358c453c0751fd88e4385824fc5ce72ef505d39373ea9fcefd0b85a26546a7b3d6b21da49799fd09851d6bd390384ab6c18873e2a9748a72ad1c"
        );

        // Test the signature is valid
        let signable = HyperlaneOffchainLookupAttestation {
            message_id: message.id(),
            ism_address,
            sender: info.sender.into(),
            call_data: info.call_data.clone().to_vec(),
        };
        let signed = SignedType {
            value: signable,
            signature: ethers::types::Signature::from_str(&signature_hex)
                .unwrap()
                .into(),
        };
        assert!(signer.verify(&signed).is_ok());
    }
}
