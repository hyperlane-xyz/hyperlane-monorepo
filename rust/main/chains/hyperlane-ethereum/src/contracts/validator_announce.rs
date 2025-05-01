#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use ethers::providers::Middleware;
use ethers_contract::builders::ContractCall;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use tracing::{instrument, trace};

use crate::{
    interfaces::i_validator_announce::{
        IValidatorAnnounce as EthereumValidatorAnnounceInternal, IVALIDATORANNOUNCE_ABI,
    },
    tx::{fill_tx_gas_params, report_tx},
    BuildableWithProvider, ConnectionConf, EthereumProvider,
};

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
    const NEEDS_SIGNER: bool = true;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumValidatorAnnounce::new(
            Arc::new(provider),
            conn,
            locator,
        ))
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
    conn: ConnectionConf,
}

impl<M> EthereumValidatorAnnounce<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a ValidatoAnnounce contract at a specific Ethereum
    /// address on some chain
    pub fn new(provider: Arc<M>, conn: &ConnectionConf, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumValidatorAnnounceInternal::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
            conn: conn.clone(),
        }
    }

    /// Returns a ContractCall that processes the provided message.
    /// If the provided tx_gas_limit is None, gas estimation occurs.
    async fn announce_contract_call(
        &self,
        announcement: SignedType<Announcement>,
    ) -> ChainResult<ContractCall<M, bool>> {
        let serialized_signature: [u8; 65] = announcement.signature.into();
        let tx = self.contract.announce(
            announcement.value.validator.into(),
            announcement.value.storage_location,
            serialized_signature.into(),
        );
        fill_tx_gas_params(
            tx,
            self.provider.clone(),
            &self.conn.transaction_overrides,
            &self.domain,
            true,
            // pass an empty value as the cache
            Default::default(),
        )
        .await
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
            .get_announced_storage_locations(
                validators.iter().map(|v| H160::from(*v).into()).collect(),
            )
            .call()
            .await?;
        Ok(storage_locations)
    }

    #[instrument(ret, skip(self))]
    async fn announce_tokens_needed(&self, announcement: SignedType<Announcement>) -> Option<U256> {
        let validator = announcement.value.validator;
        let eth_h160: ethers::types::H160 = validator.into();

        let Ok(contract_call) = self.announce_contract_call(announcement).await else {
            trace!("Unable to get announce contract call");
            return None;
        };

        let Ok(balance) = self.provider.get_balance(eth_h160, None).await else {
            trace!("Unable to query balance");
            return None;
        };

        let Some(max_cost) = contract_call.tx.max_cost() else {
            trace!("Unable to get announce max cost");
            return None;
        };
        Some(max_cost.saturating_sub(balance).into())
    }

    #[instrument(err, ret, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let contract_call = self.announce_contract_call(announcement).await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }
}

pub struct EthereumValidatorAnnounceAbi;

impl HyperlaneAbi for EthereumValidatorAnnounceAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IVALIDATORANNOUNCE_ABI)
    }
}
