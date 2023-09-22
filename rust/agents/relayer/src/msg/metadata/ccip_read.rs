use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use ethers::{abi::AbiDecode, core::utils::hex::decode as hex_decode};
use eyre::Context;
use hyperlane_core::{HyperlaneMessage, RawHyperlaneMessage, H256};
use hyperlane_ethereum::OffchainLookup;
use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{info, instrument};

use super::{BaseMetadataBuilder, MetadataBuilder};

#[derive(Serialize, Deserialize)]
struct OffchainResponse {
    data: String,
}

#[derive(Clone, Debug, new, Deref)]
pub struct CcipReadIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}

#[async_trait]
impl MetadataBuilder for CcipReadIsmMetadataBuilder {
    #[instrument(err, skip(self))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching CcipRead metadata";
        let ism = self.build_ccip_read_ism(ism_address).await.context(CTX)?;

        let response = ism
            .get_offchain_verify_info(RawHyperlaneMessage::from(message).to_vec())
            .await;
        let info: OffchainLookup = match response {
            Ok(_) => {
                info!("incorrectly configured getOffchainVerifyInfo, expected revert");
                return Ok(None);
            }
            Err(raw_error) => {
                let matching_regex = Regex::new(r"0x[[:xdigit:]]+")?;
                if let Some(matching) = &matching_regex.captures(&raw_error.to_string()) {
                    OffchainLookup::decode(hex_decode(&matching[0][2..])?)?
                } else {
                    info!("unable to parse custom error out of revert");
                    return Ok(None);
                }
            }
        };

        for url in info.urls.iter() {
            let interpolated_url = url
                .replace("{sender}", &info.sender.to_string())
                .replace("{data}", &info.call_data.to_string());
            let res = if !url.contains("{data}") {
                let body = json!({
                    "data": info.call_data.to_string(),
                    "sender": info.sender.to_string(),
                });
                Client::new()
                    .post(interpolated_url)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send()
                    .await?
            } else {
                reqwest::get(interpolated_url).await?
            };

            let json: Result<OffchainResponse, reqwest::Error> = res.json().await;

            match json {
                Ok(result) => {
                    // remove leading 0x which hex_decode doesn't like
                    let metadata = hex_decode(&result.data[2..])?;
                    return Ok(Some(metadata));
                }
                Err(_err) => {
                    // try the next URL
                }
            }
        }

        // No metadata endpoints or endpoints down
        Ok(None)
    }
}
