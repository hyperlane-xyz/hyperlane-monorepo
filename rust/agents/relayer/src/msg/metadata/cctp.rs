use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::ops::Deref;

use derive_new::new;
use tracing::{info, instrument};

use super::{BaseMetadataBuilder, MetadataBuilder};
use ethers::core::utils::hex::decode as hex_decode;
use hyperlane_core::{HyperlaneMessage, H256};
use std::time::Duration;
use tokio::time::sleep;

#[derive(Serialize, Deserialize)]
struct CctpOffchainResponse {
    status: String,
    attestation: String,
}

#[derive(Clone, Debug, new)]
pub struct CctpIsmMetadataBuilder {
    base: BaseMetadataBuilder,
}

impl Deref for CctpIsmMetadataBuilder {
    type Target = BaseMetadataBuilder;

    fn deref(&self) -> &Self::Target {
        &self.base
    }
}

#[async_trait]
impl MetadataBuilder for CctpIsmMetadataBuilder {
    #[instrument(err, skip(self))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
    ) -> eyre::Result<Option<Vec<u8>>> {
        const CTX: &str = "When fetching Cctp";
        // fetch message hash
        let message_hash = "";
        // XXX : limit loop iteration
        loop {
            let res = Client::new()
                .get("https://iris-api-sandbox.circle.com/attestations/".to_owned() + message_hash)
                .send()
                .await?;

            let json: Result<CctpOffchainResponse, reqwest::Error> = res.json().await;

            match json {
                Ok(response) => {
                    if response.status == "complete" {
                        let metadata = hex_decode(response.attestation).unwrap();
                        return Ok(Some(metadata));
                    }
                }
                Err(e) => {
                    println!("Error occurred: {}", e);
                    break;
                }
            }

            sleep(Duration::from_secs(2)).await;
        }

        // metadata endpoints down or payload is invalid
        Ok(None)
    }
}
