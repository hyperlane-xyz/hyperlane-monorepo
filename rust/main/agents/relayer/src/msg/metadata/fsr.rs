use std::sync::Arc;

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use ethers::abi::AbiDecode;
use serde::{Deserialize, Serialize};
use tracing::{info, instrument, warn};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    ccip_read::CcipReadIsmMetadataBuilder,
    message_builder::MessageMetadataBuilder,
    Metadata, MetadataBuilder,
};

/// Enhanced metadata result that includes optional message body replacement for FSR
#[derive(Debug, Clone)]
pub struct EnhancedMetadataResult {
    pub metadata: Metadata,
    pub replaced_message_body: Option<Vec<u8>>,
}

/// Response from FSR server that can include both metadata and message body replacement
#[derive(Serialize, Deserialize, Debug)]
struct FsrResponse {
    data: String,           // metadata (hex string)
    #[serde(rename = "messageBody")]
    message_body: Option<String>, // optional replacement message body (hex string)
}

/// FSR metadata builder that extends CCIP Read functionality with message body replacement
#[derive(Clone, Debug, new, Deref)]
pub struct FsrMetadataBuilder {
    #[deref]
    ccip_read_builder: CcipReadIsmMetadataBuilder,
}

impl FsrMetadataBuilder {
    /// Enhanced build method that can return both metadata and replaced message body
    #[instrument(err, skip(self, message, params))]
    pub async fn build_enhanced(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<EnhancedMetadataResult, MetadataBuildError> {
        // Get the ISM contract
        let ism = self
            .base_builder()
            .build_ccip_read_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        // Get offchain lookup info using the inherited CCIP Read functionality
        let info = self.ccip_read_builder.call_get_offchain_verify_info(ism, message).await?;

        let ccip_url_regex = super::ccip_read::create_ccip_url_regex();

        for url in info.urls.iter() {
            if ccip_url_regex.is_match(url) {
                tracing::warn!(?ism_address, url, "Suspicious CCIP read url");
                continue;
            }

            // Compute relayer authentication signature via EIP-191
            let maybe_signature_hex = if let Some(signer) = self.base_builder().get_signer() {
                Some(
                    super::ccip_read::CcipReadIsmMetadataBuilder::generate_signature_hex(
                        signer, &info, url,
                    )
                    .await?,
                )
            } else {
                None
            };

            // Prepare request data
            let sender_as_bytes = &hyperlane_core::utils::bytes_to_hex(info.sender.as_bytes());
            let data_as_bytes = &info.call_data.to_string();
            let interpolated_url = url
                .replace("{sender}", sender_as_bytes)
                .replace("{data}", data_as_bytes);

            let res = if !url.contains("{data}") {
                // POST request with JSON body
                let mut body = serde_json::json!({
                    "sender": sender_as_bytes,
                    "data": data_as_bytes
                });
                if let Some(signature_hex) = &maybe_signature_hex {
                    body["signature"] = serde_json::json!(signature_hex);
                }

                reqwest::Client::new()
                    .post(interpolated_url)
                    .header(reqwest::header::CONTENT_TYPE, "application/json")
                    .timeout(std::time::Duration::from_secs(
                        super::ccip_read::DEFAULT_TIMEOUT,
                    ))
                    .json(&body)
                    .send()
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
            } else {
                // GET request
                reqwest::get(interpolated_url)
                    .await
                    .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
            };

            // Try to parse as enhanced FSR response first
            let json_result: Result<FsrResponse, reqwest::Error> = res.json().await;

            match json_result {
                Ok(fsr_response) => {
                    // Parse metadata
                    let metadata_hex = if fsr_response.data.starts_with("0x") {
                        &fsr_response.data[2..]
                    } else {
                        &fsr_response.data
                    };
                    let metadata = hex::decode(metadata_hex)
                        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                    // Parse optional message body replacement
                    let replaced_message_body = if let Some(body_hex) = fsr_response.message_body {
                        let body_data = if body_hex.starts_with("0x") {
                            &body_hex[2..]
                        } else {
                            &body_hex
                        };
                        Some(
                            hex::decode(body_data)
                                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?,
                        )
                    } else {
                        None
                    };

                    info!(
                        ?ism_address,
                        metadata_len = metadata.len(),
                        has_replaced_body = replaced_message_body.is_some(),
                        "Successfully built FSR metadata with optional body replacement"
                    );

                    return Ok(EnhancedMetadataResult {
                        metadata: Metadata::new(metadata),
                        replaced_message_body,
                    });
                }
                Err(_err) => {
                    // try the next URL
                    warn!(?ism_address, url, "Failed to parse FSR response, trying next URL");
                }
            }
        }

        // No metadata endpoints or endpoints down
        Err(MetadataBuildError::CouldNotFetch)
    }
}

#[async_trait]
impl MetadataBuilder for FsrMetadataBuilder {
    #[instrument(err, skip(self, message, params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        // For backward compatibility, just return the metadata part
        let enhanced_result = self.build_enhanced(ism_address, message, params).await?;
        Ok(enhanced_result.metadata)
    }
}