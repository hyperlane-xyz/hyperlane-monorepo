use crate::client::provider::TonProvider;
use crate::run_get_method::StackItem;
use crate::traits::ton_api_center::TonApiCenter;
use crate::ConversionUtils;
use async_trait::async_trait;
use derive_new::new;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, H256,
};
use tonlib_core::cell::dict::predefined_readers::{key_reader_u32, val_reader_cell};
use tonlib_core::TonAddress;
use tracing::info;

#[derive(Clone, Debug, new)]
pub struct TonMultisigIsm {
    provider: TonProvider,
    multisig_address: TonAddress,
}

impl HyperlaneChain for TonMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        self.provider.provider()
    }
}

impl HyperlaneContract for TonMultisigIsm {
    fn address(&self) -> H256 {
        ConversionUtils::ton_address_to_h256(&self.multisig_address)
    }
}

#[async_trait]
impl MultisigIsm for TonMultisigIsm {
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        info!("validators_and_threshold call");
        let domain = message.origin;

        info!("Domain:{:?}", domain);

        let stack = Some(vec![StackItem {
            r#type: "num".to_string(),
            value: domain.to_string(),
        }]);
        info!("Stack:{:?}", stack);

        let function_name = "get_validators_and_threshhold".to_string();
        let response = self
            .provider
            .run_get_method(self.multisig_address.to_hex(), function_name, stack)
            .await
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to get response for get_validators_and_threshhold: {:?}",
                    e
                ))
            })?;

        let threshold_stack_item = response.stack.first().ok_or_else(|| {
            ChainCommunicationError::CustomError("No threshold stack item in response".to_string())
        })?;
        let threshold = u8::from_str_radix(threshold_stack_item.value.get(2..).unwrap_or(""), 16)
            .map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to parse threshold value: {:?}",
                e
            ))
        })?;
        info!("threshold:{:?}", threshold);

        let cell_stack_item = response.stack.get(1).ok_or_else(|| {
            ChainCommunicationError::CustomError("No cell stack item in response".to_string())
        })?;
        let root_cell = ConversionUtils::parse_root_cell_from_boc(cell_stack_item.value.as_str())
            .map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to parse_root_cell_from_boc: {:?}",
                e
            ))
        })?;

        let mut parser = root_cell.parser();
        let dict = parser
            .load_dict(32, key_reader_u32, val_reader_cell)
            .map_err(|e| {
                ChainCommunicationError::CustomError(format!(
                    "Failed to load dictionary from cell: {:?}",
                    e
                ))
            })?;

        let mut validators: Vec<H256> = vec![];

        for (key, value_cell) in &dict {
            info!("Key:{:?} value_cell:{:?}", key, value_cell);
            let mut validator_address = H256::zero();
            value_cell
                .parser()
                .load_slice(&mut validator_address.0)
                .map_err(|e| {
                    ChainCommunicationError::CustomError(format!(
                        "Failed to load_slice for validator address: {:?}",
                        e
                    ))
                })?;

            validators.push(validator_address);
        }
        Ok((validators, threshold))
    }
}
