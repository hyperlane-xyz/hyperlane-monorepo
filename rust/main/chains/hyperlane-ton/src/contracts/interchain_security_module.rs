use std::{
    fmt::{Debug, Formatter},
    time::SystemTime,
};

use async_trait::async_trait;
use base64::Engine;
use log::warn;
use num_bigint::BigUint;
use num_traits::cast::FromPrimitive;
use tonlib_core::{
    cell::{ArcCell, BagOfCells},
    message::{CommonMsgInfo, InternalMessage, TonMessage, TransferMessage},
    TonAddress,
};
use tracing::info;

use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType,
    H256, U256,
};

use crate::{
    client::provider::TonProvider, error::HyperlaneTonError, run_get_method::StackValue,
    signer::signer::TonSigner, traits::ton_api_center::TonApiCenter,
    utils::conversion::ConversionUtils, TonConnectionConf,
};

pub struct TonInterchainSecurityModule {
    /// The address of the ISM contract.
    pub ism_address: TonAddress,
    /// The provider for the ISM contract.
    pub provider: TonProvider,
    //pub wallet: TonWallet,
    pub signer: TonSigner,
    pub workchain: i32, // -1 or 0
}
impl TonInterchainSecurityModule {
    const VERIFY: u32 = 0x3b3cca17;
    pub fn new(locator: ContractLocator, conf: TonConnectionConf, signer: TonSigner) -> Self {
        let ism_address = ConversionUtils::h256_to_ton_address(&locator.address, 0);
        let provider = TonProvider::new(reqwest::Client::new(), conf, locator.domain.clone());

        Self {
            ism_address,
            provider,
            signer,
            workchain: 0,
        }
    }
}
impl Debug for TonInterchainSecurityModule {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ton mailbox:")
            .field("provider", &self.provider)
            .field("wallet:", &self.signer.wallet.address.to_hex())
            .finish()
    }
}

impl HyperlaneContract for TonInterchainSecurityModule {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.ism_address)
    }
}
impl HyperlaneChain for TonInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

#[async_trait]
impl InterchainSecurityModule for TonInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let function_name = "get_module_type".to_string();
        let response = self
            .provider
            .run_get_method(self.ism_address.to_hex(), function_name, None)
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to run get_module_type method: {:?}",
                    e
                )))
            })?;

        let stack_item = response.stack.get(0).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                "Empty stack in response".to_string(),
            ))
        })?;
        let boc = match &stack_item.value {
            StackValue::String(boc) => boc,
            _ => {
                return Err(ChainCommunicationError::from(
                    HyperlaneTonError::ParsingError(
                        "Failed to get boc: unexpected data type in stack value".to_string(),
                    ),
                ));
            }
        };
        let module_type_value = u32::from_str_radix(&boc[2..], 16).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to parse module type value: {:?}",
                e
            )))
        })?;

        let module_type = ModuleType::from_u32(module_type_value).ok_or_else(|| {
            ChainCommunicationError::from(HyperlaneTonError::UnknownModuleType(module_type_value))
        })?;

        Ok(module_type)
    }

    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        let message_cell = ConversionUtils::build_hyperlane_message_cell(message).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to build HyperlaneMessage to Ton Cell: {:?}",
                e
            )))
        })?;

        let metadata_cell = ConversionUtils::metadata_to_cell(metadata).map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to build metadata cell: {:?}",
                e
            )))
        })?;

        let query_id = 1;
        let block_number = 1;

        let msg = crate::contracts::mailbox::build_message(
            TonInterchainSecurityModule::VERIFY,
            ArcCell::new(message_cell),
            ArcCell::new(metadata_cell),
            query_id,
            block_number,
        )
        .map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                "Failed to build message: {}",
                e
            )))
        })?;

        let common_msg_info = CommonMsgInfo::InternalMessage(InternalMessage {
            ihr_disabled: false,
            bounce: false,
            bounced: false,
            src: self.signer.address.clone(),
            dest: self.ism_address.clone(),
            value: BigUint::from(100000000u32),
            ihr_fee: Default::default(),
            fwd_fee: Default::default(),
            created_lt: 0,
            created_at: 0,
        });

        let transfer_message = TransferMessage {
            common_msg_info,
            state_init: None,
            data: Some(ArcCell::new(msg.clone())),
        }
        .build()
        .map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::FailedBuildingCell(format!(
                "Failed to build transfer message: {}",
                e
            )))
        })?;

        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                    "Failed to build duration_since: {:?}",
                    e
                )))
            })?
            .as_secs() as u32;

        let wallet_state_response = self
            .provider
            .get_wallet_states(self.signer.address.to_hex())
            .await
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to get wallet state: {:?}",
                    e
                )))
            })?;

        let seqno = wallet_state_response
            .wallets
            .get(0)
            .ok_or_else(|| {
                ChainCommunicationError::from(HyperlaneTonError::ApiInvalidResponse(
                    "Wallet state is empty".to_string(),
                ))
            })?
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
                ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                    "Failed to create external message: {}",
                    e
                )))
            })?;

        let boc = BagOfCells::from_root(message.clone())
            .serialize(true)
            .map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                    "Failed to serialize BOC: {}",
                    e
                )))
            })?;
        let boc_str = base64::engine::general_purpose::STANDARD.encode(boc.clone());

        let tx = self.provider.send_message(boc_str).await.map_err(|e| {
            ChainCommunicationError::from(HyperlaneTonError::ApiRequestFailed(format!(
                "Failed to send message: {}",
                e
            )))
        })?;
        info!("Tx hash:{:?}", tx.message_hash);

        let result = self.provider.wait_for_transaction(tx.message_hash).await;
        match result {
            Ok(gas_estimate) => Ok(Some(gas_estimate.gas_used)),
            Err(e) => {
                warn!("Dry run verify has error:{:?}", e);
                Ok(None)
            }
        }
    }
}
