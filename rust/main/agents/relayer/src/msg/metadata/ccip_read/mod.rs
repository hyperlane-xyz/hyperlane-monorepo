#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
use async_trait::async_trait;
use cache_types::SerializedOffchainLookup;
use derive_more::Deref;
use derive_new::new;
use ethers::{abi::AbiDecode, core::utils::hex::decode as hex_decode};
use hyperlane_base::cache::FunctionCallCache;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{info, instrument, warn};

use hyperlane_core::{
    utils::bytes_to_hex, CcipReadIsm, HyperlaneMessage, RawHyperlaneMessage, H256,
};
use hyperlane_ethereum::OffchainLookup;

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

impl CcipReadIsmMetadataBuilder {
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

        self.base_builder()
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
            .base_builder()
            .build_ccip_read_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        let info = self.call_get_offchain_verify_info(ism, message).await?;

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
                let body = json!({
                    "sender": sender_as_bytes,
                    "data": data_as_bytes
                });
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
