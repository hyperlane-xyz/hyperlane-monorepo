#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    utils::bytes_to_hex, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneProvider, TxOutcome, H256, U256,
};
use hyperlane_core::{Announcement, Encode, SignedType, ValidatorAnnounce};
use starknet::accounts::{Execution, SingleOwnerAccount};
use starknet::core::types::{FieldElement, MaybePendingTransactionReceipt, TransactionReceipt};
use starknet::core::utils::{parse_cairo_short_string, ParseCairoShortStringError};
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::{instrument, trace};

use crate::contracts::validator_announce::ValidatorAnnounce as StarknetValidatorAnnounceInternal;
use crate::error::HyperlaneStarknetError;
use crate::{
    build_single_owner_account, get_transaction_receipt, string_to_cairo_long_string,
    to_strk_message_bytes, ConnectionConf, Signer, StarknetProvider,
};
use cainome::cairo_serde::EthAddress;

impl<A> std::fmt::Display for StarknetValidatorAnnounceInternal<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// A reference to a ValidatorAnnounce contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetValidatorAnnounce {
    contract: Arc<StarknetValidatorAnnounceInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetValidatorAnnounce {
    /// Create a reference to a ValidatorAnnounce at a specific Starknet address on some
    /// chain
    pub fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator,
        signer: Signer,
    ) -> ChainResult<Self> {
        let account = build_single_owner_account(
            &conn.url,
            signer.local_wallet(),
            &signer.address,
            false,
            locator.domain.id(),
        );

        let contract = StarknetValidatorAnnounceInternal::new(
            locator
                .address
                .try_into()
                .map_err(HyperlaneStarknetError::BytesConversionError)?,
            account,
        );

        Ok(Self {
            contract: Arc::new(contract),
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    /// Returns a ContractCall that processes the provided message.
    async fn announce_contract_call(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<(
        Execution<'_, SingleOwnerAccount<AnyProvider, LocalWallet>>,
        FieldElement,
    )> {
        let validator = FieldElement::from_byte_slice_be(&announcement.value.validator.to_vec())
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let storage_location = string_to_cairo_long_string(&announcement.value.storage_location)
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        let signature_bytes = announcement.signature.to_vec();
        let signature = &to_strk_message_bytes(&signature_bytes);

        let tx = self
            .contract
            .announce(&EthAddress(validator), &storage_location, signature);

        let gas_estimate = tx
            .estimate_fee()
            .await
            .map_err(|e| HyperlaneStarknetError::AccountError(e.to_string()))?
            .overall_fee;

        let max_cost = gas_estimate * FieldElement::TWO;

        Ok((tx.max_fee(max_cost), max_cost))
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetValidatorAnnounceInternal<SingleOwnerAccount<AnyProvider, LocalWallet>> {
        &self.contract
    }
}

impl HyperlaneChain for StarknetValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetValidatorAnnounce {
    fn address(&self) -> H256 {
        self.contract.address.into()
    }
}

#[async_trait]
impl ValidatorAnnounce for StarknetValidatorAnnounce {
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let validators_calldata: Vec<EthAddress> = validators
            .iter()
            .map(|v| {
                TryInto::<FieldElement>::try_into(*v).map_err(Into::<HyperlaneStarknetError>::into)
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(EthAddress)
            .collect();

        let storage_locations_res = self
            .contract
            .get_announced_storage_locations(&validators_calldata)
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let storage_locations = storage_locations_res
            .into_iter()
            .map(|validator_vec| {
                validator_vec
                    .into_iter()
                    .map(|inner_vec| {
                        inner_vec
                            .into_iter()
                            .map(|element| parse_cairo_short_string(&element))
                            .collect::<Result<Vec<String>, ParseCairoShortStringError>>()
                    })
                    .collect::<Result<Vec<Vec<String>>, ParseCairoShortStringError>>()
                    .map(|strings_vec| {
                        strings_vec
                            .into_iter()
                            .map(|inner_vec| inner_vec.join(""))
                            .collect::<Vec<String>>()
                    })
            })
            .collect::<Result<Vec<Vec<String>>, ParseCairoShortStringError>>()
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(storage_locations)
    }

    #[instrument(ret, skip(self))]
    async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256> {
        let validator = bytes_to_hex(&announcement.value.validator.to_vec());

        let Ok((_, max_cost)) = self.announce_contract_call(announcement).await else {
            trace!("Unable to get announce contract call");
            return None;
        };

        let Ok(balance) = self.provider.get_balance(validator).await else {
            trace!("Unable to query balance");
            return None;
        };

        let max_cost_u256: U256 = max_cost.into();

        Some(max_cost_u256.saturating_sub(balance).into())
    }

    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let (contract_call, _) = self.announce_contract_call(announcement).await?;
        let tx = contract_call
            .send()
            .await
            .map_err(|e| HyperlaneStarknetError::AccountError(e.to_string()))?;
        let invoke_tx_receipt =
            get_transaction_receipt(&self.provider.rpc_client(), tx.transaction_hash).await;
        match invoke_tx_receipt {
            Ok(MaybePendingTransactionReceipt::Receipt(TransactionReceipt::Invoke(receipt))) => {
                return Ok(receipt.try_into()?);
            }
            _ => {
                return Err(HyperlaneStarknetError::InvalidTransactionReceipt.into());
            }
        }
    }
}

pub struct StarknetValidatorAnnounceAbi;

impl HyperlaneAbi for StarknetValidatorAnnounceAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
