#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use ethers_contract::builders::ContractCall;
use hyperlane_core::{
    Announcement, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, SignedType, TxOutcome, ValidatorAnnounce, H160, H256, U256,
};
use tracing::{instrument, trace};

use crate::{
    interfaces::i_validator_announce::IValidatorAnnounce as TronValidatorAnnounceInternal,
    TronProvider,
};

/// A reference to a ValidatorAnnounce contract on some Tron chain
#[derive(Debug)]
pub struct TronValidatorAnnounce {
    contract: Arc<TronValidatorAnnounceInternal<TronProvider>>,
    domain: HyperlaneDomain,
    provider: Arc<TronProvider>,
}

impl TronValidatorAnnounce {
    /// Create a reference to a ValidatoAnnounce contract at a specific Tron
    /// address on some chain
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        let provider = Arc::new(provider);
        Self {
            contract: Arc::new(TronValidatorAnnounceInternal::new(
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
    ) -> ChainResult<ContractCall<TronProvider, bool>> {
        let serialized_signature: [u8; 65] = announcement.signature.into();
        let tx = self.contract.announce(
            announcement.value.validator.into(),
            announcement.value.storage_location,
            serialized_signature.into(),
        );
        Ok(tx)
    }
}

impl HyperlaneChain for TronValidatorAnnounce {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for TronValidatorAnnounce {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl ValidatorAnnounce for TronValidatorAnnounce {
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
    async fn announce_tokens_needed(
        &self,
        announcement: SignedType<Announcement>,
        chain_signer: H256,
    ) -> Option<U256> {
        let Ok(contract_call) = self.announce_contract_call(announcement).await else {
            trace!("Unable to get announce contract call");
            return None;
        };

        let chain_signer_h160 = ethers::types::H160::from(chain_signer);
        let Ok(balance) = Middleware::get_balance(&self.provider, chain_signer_h160, None).await
        else {
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
    async fn announce(&self, announcement: SignedType<Announcement>) -> ChainResult<TxOutcome> {
        let contract_call = self.announce_contract_call(announcement).await?;
        self.provider.send_and_wait(&contract_call).await
    }
}
