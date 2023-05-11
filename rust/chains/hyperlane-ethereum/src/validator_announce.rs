#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::{Middleware, ProviderError};

use ethers_contract::builders::ContractCall;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use tracing::instrument;

use crate::contracts::i_validator_announce::{
    IValidatorAnnounce as EthereumValidatorAnnounceInternal, IVALIDATORANNOUNCE_ABI,
};
use crate::trait_builder::BuildableWithProvider;
use crate::tx::{fill_tx_gas_params, report_tx};
use crate::EthereumProvider;

impl<M> std::fmt::Display for EthereumValidatorAnnounceInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct ValidatorAnnounceBuilder {}

#[async_trait]
impl BuildableWithProvider for ValidatorAnnounceBuilder {
    type Output = Box<dyn ValidatorAnnounce>;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumValidatorAnnounce::new(Arc::new(provider), locator))
    }
}

/// A reference to a ValidatorAnnounce contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumValidatorAnnounce<M>
where
    M: Middleware,
{
    contract: Arc<EthereumValidatorAnnounceInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
}

impl<M> EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a ValidatoAnnounce contract at a specific Ethereum
    /// address on some chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumValidatorAnnounceInternal::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn announce_contract_call(
        &self,
        announcement: SignedType<Announcement>,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<ContractCall<M, bool>> {
        let serialized_signature: [u8; 65] = announcement.signature.into();
        let tx = self.contract.announce(
            announcement.value.validator,
            announcement.value.storage_location,
            serialized_signature.into(),
        );
        fill_tx_gas_params(tx, tx_gas_limit, self.provider.clone(), self.domain.id()).await
    }
}

impl<M> HyperlaneChain for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> ValidatorAnnounce for EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    async fn get_announced_storage_locations(
        &self,
        validators: &[H256],
    ) -> ChainResult<Vec<Vec<String>>> {
        let storage_locations = self
            .contract
            .get_announced_storage_locations(validators.iter().map(|v| H160::from(*v)).collect())
            .call()
            .await?;
        Ok(storage_locations)
    }

    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<U256> {
        let validator = announcement.value.validator;
        let contract_call = self
            .announce_contract_call(announcement, None)
            .await?;
        if let Ok(balance) = self.provider.get_balance(validator, None).await {
            if let Some(cost) = contract_call.tx.max_cost() {
                Ok(cost.saturating_sub(balance))
            } else {
                Err(ProviderError::CustomError("Unable to get announce max cost".into()).into())
            }
        } else {
            Err(ProviderError::CustomError("Unable to query balance".into()).into())
        }
    }

    #[instrument(err, ret, skip(self))]
    async fn announce(
        &self,
        announcement: SignedType<Announcement>,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self
            .announce_contract_call(announcement, tx_gas_limit)
            .await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }
}

pub struct EthereumValidatorAnnounceAbi;

impl HyperlaneAbi for EthereumValidatorAnnounceAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        super::extract_fn_map(&IVALIDATORANNOUNCE_ABI)
    }
}
