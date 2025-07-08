use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use ethers::utils::hex;
use serde::{Deserialize, Serialize};
use tracing::{info, instrument, warn};

use hyperlane_core::{HyperlaneMessage, H256};

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    ccip_read::CcipReadIsmMetadataBuilder,
    Metadata, MetadataBuilder,
};

/// FSR sentinel value used for origin field to trigger FSR routing
const FSR_SENTINEL_ORIGIN: u32 = 0xFF;

/// FSR header structure (37 bytes total)
#[derive(Debug, Clone)]
pub struct FsrHeader {
    pub origin: u32,        // Actual origin domain
    pub directive_type: u8, // Type of directive
    pub message_id: H256,   // Original Hyperlane message ID
}

/// Enhanced metadata result that includes optional message transformation for FSR
#[derive(Debug, Clone)]
pub struct EnhancedMetadataResult {
    pub metadata: Metadata,
    pub transformed_message: Option<HyperlaneMessage>,
}

/// Response from FSR server
#[derive(Serialize, Deserialize, Debug)]
struct FsrResponse {
    provider_id: u8,  // provider ID for ISM routing
    origin: u32,      // actual origin domain ID
    metadata: String, // metadata (hex string)
    #[serde(rename = "directiveType")]
    directive_type: u8, // FSR directive type
    #[serde(rename = "directivePayload")]
    directive_payload: String, // directive payload (hex string)
}

/// FSR metadata builder that extends CCIP Read functionality with message body replacement
#[derive(Clone, Debug, new, Deref)]
pub struct FsrMetadataBuilder {
    #[deref]
    ccip_read_builder: CcipReadIsmMetadataBuilder,
}

impl FsrHeader {
    /// Create a new FSR header
    pub fn new(origin: u32, message_id: H256, directive_type: u8) -> Self {
        Self {
            origin,
            directive_type,
            message_id,
        }
    }

    /// Encode FSR header as bytes (37 bytes total)
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(37);
        bytes.extend_from_slice(&self.origin.to_be_bytes()); // 4 bytes
        bytes.push(self.directive_type); // 1 byte
        bytes.extend_from_slice(self.message_id.as_bytes()); // 32 bytes
        bytes
    }

    /// Decode FSR header from bytes
    pub fn decode(bytes: &[u8]) -> Result<Self, MetadataBuildError> {
        if bytes.len() < 37 {
            return Err(MetadataBuildError::FailedToBuild(
                "FSR header too short".to_string(),
            ));
        }

        let origin = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        let directive_type = bytes[4];
        let message_id = H256::from_slice(&bytes[5..37]);

        Ok(Self {
            origin,
            directive_type,
            message_id,
        })
    }
}

/// Encode complete FSR body with header and payload
fn encode_fsr_body(header: &FsrHeader, payload: &[u8]) -> Vec<u8> {
    let mut body = header.encode();
    body.extend_from_slice(payload);
    body
}

impl FsrMetadataBuilder {
    /// Enhanced build method that can return both metadata and replaced message body
    #[instrument(err, skip(self, message, _params))]
    pub async fn build_enhanced(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<EnhancedMetadataResult, MetadataBuildError> {
        // Get the ISM contract
        let ism = self
            .base_builder()
            .build_ccip_read_ism(ism_address)
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

        // Get offchain lookup info using the inherited CCIP Read functionality
        let info = self
            .ccip_read_builder
            .call_get_offchain_verify_info(ism, message)
            .await?;

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
                    let metadata_hex = if fsr_response.metadata.starts_with("0x") {
                        &fsr_response.metadata[2..]
                    } else {
                        &fsr_response.metadata
                    };
                    let metadata = hex::decode(metadata_hex)
                        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                    // Parse directive payload
                    let payload_hex = if fsr_response.directive_payload.starts_with("0x") {
                        &fsr_response.directive_payload[2..]
                    } else {
                        &fsr_response.directive_payload
                    };
                    let directive_payload = hex::decode(payload_hex)
                        .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

                    // Create FSR header
                    let message_id = message.id();
                    let fsr_header = FsrHeader::new(
                        fsr_response.origin,
                        message_id,
                        fsr_response.directive_type,
                    );

                    // Encode complete FSR body
                    let fsr_body = encode_fsr_body(&fsr_header, &directive_payload);

                    // Create FSR origin by appending provider_id to 0xFF
                    let fsr_origin = (FSR_SENTINEL_ORIGIN << 8) | (fsr_response.provider_id as u32);

                    // Create transformed message with FSR routing
                    let transformed_message = HyperlaneMessage {
                        version: message.version,
                        nonce: message.nonce,
                        origin: fsr_origin, // 0xFF00 + provider_id for domain routing
                        sender: message.sender,
                        destination: message.destination, // Keep original destination for relayer
                        recipient: message.recipient,
                        body: fsr_body,
                    };

                    info!(
                        ?ism_address,
                        metadata_len = metadata.len(),
                        original_origin = message.origin,
                        actual_fsr_origin = fsr_response.origin,
                        provider_id = fsr_response.provider_id,
                        transformed_origin = fsr_origin,
                        directive_type = fsr_response.directive_type,
                        "Successfully built FSR metadata and transformed message"
                    );

                    return Ok(EnhancedMetadataResult {
                        metadata: Metadata::new(metadata),
                        transformed_message: Some(transformed_message),
                    });
                }
                Err(_err) => {
                    // try the next URL
                    warn!(
                        ?ism_address,
                        url, "Failed to parse FSR response, trying next URL"
                    );
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
