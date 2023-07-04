use async_trait::async_trait;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ops::Deref;
use std::convert::TryInto;
use std::str;

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
        let body: &Vec<u8> = &message.body;
        let nonce = self.extract_nonce_from_message(body).unwrap_or_else(|error| {
            eprintln!("Error: {}", error);
            0
        });
        println!("Extracted Nonce: {}", nonce);
    
        let result = self.execute_graphql_query(self.create_graphql_query(nonce)).await.unwrap_or_else(|error| {
            eprintln!("Error: {}", error);
            return Value::Null
        });
        let data = result["data"].as_object();
        let message_sents = data.and_then(|d| d["messageSents"].as_array());
        if let Some(message_sents) = message_sents {
            for message_sent in message_sents {
                let message = message_sent["message"].as_str().unwrap(); // 248 bytes
                let message_hash = H256::from_slice(message.as_bytes());

                loop {
                    let res = Client::new()
                        .get(&format!(r#"https://iris-api-sandbox.circle.com/attestations/"{}""#, message_hash.to_string()))
                        .send()
                        .await?;
        
                    let json: Result<CctpOffchainResponse, reqwest::Error> = res.json().await;
        
                    match json {
                        Ok(response) => {
                            if response.status == "complete" {
                                let mut metadata = hex_decode(response.attestation).unwrap();
                                metadata.append(&mut message.as_bytes().to_owned());
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
            }
        }

        // metadata endpoints down or payload is invalid
        Ok(None)
    }
}

impl CctpIsmMetadataBuilder {
    pub fn extract_nonce_from_message(&self, bytes: &[u8]) -> Result<u64, &'static str> {
        if bytes.len() < 28 {
            return Err("Insufficient bytes to extract uint64");
        }

        let uint64_bytes = &bytes[20..28];
        let uint64 = u64::from_be_bytes(uint64_bytes.try_into().unwrap());
        Ok(uint64)
    }

    pub fn create_graphql_query(&self, nonce_value: u64) -> Value {
        json!({
            "query": r#"
                query GetMessageSents($nonce: String!) {
                    messageSents(where: { nonce: $nonce }) {
                        id
                        message
                        messageLength
                        nonce
                        blockNumber
                        blockTimestamp
                        transactionHash
                    }
                }
            "#,
            "variables": {
                "nonce": nonce_value
            }
        })
    }

    pub async fn execute_graphql_query(&self, query: Value) -> Result<Value, reqwest::Error> {
        let client = Client::new();
        let response = client
            .post("https://api.studio.thegraph.com/query/49312/cctp/version/latest")
            .json(&query)
            .send()
            .await?
            .json()
            .await?;
    
        Ok(response)
    }    
}
