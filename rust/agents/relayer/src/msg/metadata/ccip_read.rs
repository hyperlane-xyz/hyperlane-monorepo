use async_trait::async_trait;
use hyperlane_ethereum::OffchainLookup;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::ops::Deref;
use strum::Display;

use derive_new::new;
use eyre::Context;
use tracing::instrument;

use super::{BaseMetadataBuilder, MetadataBuilder};
use ethers::core::utils::hex::decode as hex_decode;
use ethers::providers::Middleware;
use ethers::{abi::AbiDecode, prelude::k256::pkcs8::der::Encode};
use ethers_contract::EthError;
use hyperlane_core::{ChainCommunicationError, HyperlaneMessage, H256};
use regex::Regex;

#[derive(Serialize, Deserialize)]
struct OffchainResponse {
    metadata: String,
    message: String,
}

#[derive(Debug, Display, PartialEq, Eq, Clone)]
pub enum MetadataTokenLayout {
    Mailbox,
    Threshold,
    Signatures,
    Validators,
}

#[derive(Clone, Debug, new)]
pub struct CcipReadIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}

impl Deref for CcipReadIsmMetadataBuilder {
    type Target = BaseMetadataBuilder;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
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
        let info_result = ism.get_offchain_verify_info(message).await.context(CTX);

        let info: OffchainLookup = match info_result {
            Ok(a) => panic!("Shouldn't get here"),
            Err(e) => match e.downcast_ref::<ChainCommunicationError>() {
                Some(err) => {
                    println!("err {:?}", err);
                    let regex = Regex::new(r"0x[[:xdigit:]]+").unwrap();

                    if let Some(capture) = regex.captures(&err.to_string()) {
                        let extracted = &capture[0];

                        let data = hex_decode(extracted.replace("0x", "")).unwrap();
                        OffchainLookup::decode(data).unwrap()
                    } else {
                        panic!("Shouldn't get here");
                        // Err(hyperlane_core::ChainCommunicationError::TransactionTimeout())
                    }
                }
                None => panic!("Shouldn't get here"),
            },
        };

        for url in info.urls.iter() {
            let request_url = url
                .replace("{sender}", &info.sender.to_string())
                .replace("{data}", &info.call_data.to_string());
            let res = if url.contains("{data}") {
                let body = json!({
                    "data": info.call_data.to_string(),
                    "sender": info.sender.to_string(),
                });
                Client::new()
                    .post(request_url)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send()
                    .await?
            } else {
                reqwest::get(request_url).await?
            };

            let json: Result<OffchainResponse, reqwest::Error> = res.json().await;

            match json {
                Ok(result) => {
                    // remove leading 0x which hex_decode doesn't like
                    let metadata = hex_decode(&result.metadata[2..]).unwrap();
                    return Ok(Some(metadata));
                }
                Err(_err) => {
                    // let the next URL
                }
            }
        }

        Ok(None)
    }
}
