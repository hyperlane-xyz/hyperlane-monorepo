use crate::client::provider::TonProvider;
use crate::signer::signer::TonSigner;
use crate::traits::ton_api_center::TonApiCenter;
use crate::utils::conversion::ConversionUtils;
use async_trait::async_trait;
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Signable, SignedType, TxOutcome, ValidatorAnnounce, H256,
    U256,
};

use crate::run_get_method::StackItem;
use base64::engine::general_purpose;
use base64::Engine;
use log::{info, warn};
use num_bigint::BigUint;
use std::fmt::{Debug, Formatter};
use std::time::SystemTime;
use tonlib_core::{
    cell::{ArcCell, BagOfCells, Cell, CellBuilder},
    message::{CommonMsgInfo, InternalMessage, TonMessage, TransferMessage},
    TonAddress,
};

pub struct TonValidatorAnnounce {
    address: TonAddress,
    provider: TonProvider,
    signer: TonSigner,
}

impl Debug for TonValidatorAnnounce {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TonValidatorAnnounce")
            .field("workchain:", &self.address.workchain)
            .field("address:", &self.address.to_hex())
            .field("provider:", &self.provider)
            .field("signer", &"<signer omitted>")
            .finish()
    }
}

impl TonValidatorAnnounce {
    const ANNOUNCE_OPCODE: u32 = 0x980b3d44;
    pub fn new(address: TonAddress, provider: TonProvider, signer: TonSigner) -> Self {
        Self {
            address,
            provider,
            signer,
        }
    }
    pub fn build_announcement_cell(
        &self,
        announcement: SignedType<Announcement>,
    ) -> Result<Cell, String> {
        let query_id = BigUint::from(1u32);

        // Convert validator address to BigUint
        let validator_addr = BigUint::from_bytes_be(announcement.value.validator.as_bytes());

        // Create the sub-cell for storage_location
        let sub_cell = CellBuilder::new()
            .store_slice(announcement.value.storage_location.as_bytes())
            .map_err(|e| format!("Failed to store storage location: {:?}", e))?
            .build()
            .map_err(|e| format!("Failed to finalize sub_cell: {:?}", e))?;

        let signature_cell = CellBuilder::new()
            .store_uint(8, &BigUint::from(announcement.signature.v))
            .map_err(|e| format!("Failed to store signature v: {:?}", e))?
            .store_uint(
                256,
                &ConversionUtils::u256_to_biguint(announcement.signature.r),
            )
            .map_err(|e| format!("Failed to store signature r: {:?}", e))?
            .store_uint(
                256,
                &ConversionUtils::u256_to_biguint(announcement.signature.s),
            )
            .map_err(|e| format!("Failed to store signature s: {:?}", e))?
            .build()
            .map_err(|e| format!("Failed to finalize signature_cell: {:?}", e))?;

        let announce_cell = CellBuilder::new()
            .store_u32(32, TonValidatorAnnounce::ANNOUNCE_OPCODE)
            .map_err(|e| format!("Failed to store ANNOUNCE_OPCODE: {:?}", e))?
            .store_uint(64, &query_id)
            .map_err(|e| format!("Failed to store query_id: {:?}", e))?
            .store_uint(256, &validator_addr)
            .map_err(|e| format!("Failed to store validator address: {:?}", e))?
            .store_reference(&ArcCell::new(sub_cell))
            .map_err(|e| format!("Failed to store sub_cell reference: {:?}", e))?
            .store_reference(&ArcCell::new(signature_cell))
            .map_err(|e| format!("Failed to store signature_cell reference: {:?}", e))?
            .build()
            .map_err(|e| format!("Failed to finalize announce_cell: {:?}", e))?;

        info!("Announcement cell built successfully");
        Ok(announce_cell)
    }
}
impl HyperlaneContract for TonValidatorAnnounce {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.address)
    }
}

impl HyperlaneChain for TonValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

#[async_trait]
impl ValidatorAnnounce for TonValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        info!(
            "get_announced_storage_locations call! validators:{:?}",
            validators
        );
        let function_name = "get_announced_storage_locations".to_string();
        let validators_cell =
            ConversionUtils::create_address_linked_cells(&validators).map_err(|_| {
                ChainCommunicationError::CustomError(
                    "Failed to create address linked cells".to_string(),
                )
            })?;

        let boc = BagOfCells::from_root(validators_cell)
            .serialize(true)
            .map_err(|_e| ChainCommunicationError::CustomError(_e.to_string()))?;
        let boc_str = general_purpose::STANDARD.encode(&boc);

        let stack = Some(vec![StackItem {
            r#type: "cell".to_string(),
            value: boc_str,
        }]);

        let response = self
            .provider
            .run_get_method(self.address.to_hex(), function_name, stack)
            .await
            .map_err(|_e| {
                warn!("Failed to run get method");
                ChainCommunicationError::CustomError(_e.to_string())
            })?;

        if response.exit_code != 0 {
            return Err(ChainCommunicationError::CustomError(format!(
                "Non-zero exit code in response: {}",
                response.exit_code
            )));
        }

        if let Some(stack_item) = response.stack.get(0) {
            let cell_boc_decoded = general_purpose::STANDARD
                .decode(&stack_item.value)
                .map_err(|_| {
                    ChainCommunicationError::CustomError(
                        "Failed to decode cell BOC from response".to_string(),
                    )
                })?;

            let boc = BagOfCells::parse(&cell_boc_decoded).map_err(|_e| {
                ChainCommunicationError::CustomError(format!("Failed to parse BOC: {}", _e))
            })?;

            let cell = boc.single_root().map_err(|_e| {
                ChainCommunicationError::CustomError(format!("Failed to get root cell: {}", _e))
            })?;

            let storage_locations = ConversionUtils::parse_address_storage_locations(&cell)
                .map_err(|_e| {
                    ChainCommunicationError::CustomError(format!(
                        "Failed to parse address storage locations: {}",
                        _e
                    ))
                })?;
            info!("storage_locations:{:?}", storage_locations);

            let locations_vec: Vec<Vec<String>> = storage_locations.into_values().collect();
            info!("locations_vec:{:?}", locations_vec);
            Ok(locations_vec)
        } else {
            Ok(vec![vec![]])
        }
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        info!("announce call!");
        info!(
            "announcement value:{:?} signature:{:?}",
            announcement.value, announcement.signature
        );

        info!(
            "eth_signed_message_hash:{:x}",
            announcement.value.eth_signed_message_hash()
        );
        info!("signing_hash:{:x}", announcement.value.signing_hash());
        let cell = self
            .build_announcement_cell(announcement)
            .map_err(|_e| ChainCommunicationError::CustomError(_e))?;
        let common_msg_info = CommonMsgInfo::InternalMessage(InternalMessage {
            ihr_disabled: false,
            bounce: true,
            bounced: false,
            src: self.signer.address.clone(),
            dest: self.address.clone(),
            value: BigUint::from(20000000u32),
            ihr_fee: Default::default(),
            fwd_fee: Default::default(),
            created_lt: 0,
            created_at: 0,
        });
        let transfer_message = TransferMessage {
            common_msg_info,
            state_init: None,
            data: Some(ArcCell::new(cell.clone())),
        }
        .build()
        .expect("Failed create transfer message");
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("Failed to build duration_since")
            .as_secs() as u32;

        let seqno = self
            .provider
            .get_wallet_states(self.signer.address.to_hex())
            .await
            .expect("Failed to get wallet state")
            .wallets[0]
            .seqno as u32;

        let message = self
            .signer
            .wallet
            .create_external_message(
                now + 60,
                seqno,
                vec![ArcCell::new(transfer_message.clone())],
                false,
            )
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to create external message:{:?}",
                    e
                ))
            })?;
        info!("Message cell in announce:{:?}", message);

        let boc = BagOfCells::from_root(message.clone())
            .serialize(true)
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!("Failed to get boc from root:{:?}", e))
            })?;

        let boc_str = general_purpose::STANDARD.encode(boc.clone());
        tracing::info!("create_external_message:{:?}", boc_str);

        let tx = self
            .provider
            .send_message(boc_str)
            .await
            .expect("Failed to get tx");
        tracing::info!("Tx hash:{:?}", tx.message_hash);

        self.provider.wait_for_transaction(tx.message_hash).await
    }

    async fn announce_tokens_needed(
        &self,
        _announcement: SignedType<Announcement>,
    ) -> Option<U256> {
        Some(U256::zero())
    }
}
