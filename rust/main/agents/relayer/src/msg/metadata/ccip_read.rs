#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use ethers::{abi::AbiDecode, core::utils::hex::decode as hex_decode};
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{info, instrument};

use hyperlane_core::{utils::bytes_to_hex, HyperlaneMessage, RawHyperlaneMessage, H256};
use hyperlane_ethereum::OffchainLookup;

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    message_builder::MessageMetadataBuilder,
    Metadata, MetadataBuilder,
};

#[derive(Serialize, Deserialize)]
struct OffchainResponse {
    data: String,
}

#[derive(Clone, Debug, new, Deref)]
pub struct CcipReadIsmMetadataBuilder {
    base: MessageMetadataBuilder,
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

        let response = ism
            .get_offchain_verify_info(RawHyperlaneMessage::from(message).to_vec())
            .await;
        let info: OffchainLookup = match response {
            Ok(_) => {
                info!("incorrectly configured getOffchainVerifyInfo, expected revert");
                return Err(MetadataBuildError::CouldNotFetch);
            }
            Err(raw_error) => {
                let matching_regex = Regex::new(r"0x[[:xdigit:]]+")
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
                if let Some(matching) = &matching_regex.captures(&raw_error.to_string()) {
                    let hex_val = hex_decode(&matching[0][2..])
                        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
                    OffchainLookup::decode(hex_val)
                        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
                } else {
                    info!(?raw_error, "unable to parse custom error out of revert");
                    return Err(MetadataBuildError::CouldNotFetch);
                }
            }
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
