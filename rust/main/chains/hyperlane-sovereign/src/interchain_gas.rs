use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, InterchainGasPaymaster, InterchainGasPayment, H256, U256,
};
use serde::Deserialize;

use crate::types::TxEvent;
use crate::{ConnectionConf, Signer, SovereignProvider};

/// A reference to a `InterchainGasPaymasterIndexer` contract on some Sovereign chain
#[derive(Debug, Clone)]
pub struct SovereignInterchainGasPaymasterIndexer {
    provider: SovereignProvider,
}

impl SovereignInterchainGasPaymasterIndexer {
    /// Create a new `SovereignInterchainGasPaymasterIndexer`.
    pub async fn new(
        conf: ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider = SovereignProvider::new(locator.domain.clone(), &conf, signer).await?;

        Ok(SovereignInterchainGasPaymasterIndexer { provider })
    }
}

#[derive(Deserialize)]
struct Igp {
    gas_payment: MessageBody,
}

#[derive(Deserialize)]
struct MessageBody {
    message_id: H256,
    dest_domain: u32,
    payment: String,
    gas_limit: String,
}

#[async_trait]
impl crate::indexer::SovIndexer<InterchainGasPayment> for SovereignInterchainGasPaymasterIndexer {
    const EVENT_KEY: &'static str = "InterchainGasPaymaster/GasPayment";

    fn provider(&self) -> &SovereignProvider {
        &self.provider
    }

    async fn latest_sequence(&self, at_slot: Option<u64>) -> ChainResult<Option<u32>> {
        let sequence = self.provider().get_count(at_slot).await?;

        Ok(Some(sequence))
    }

    fn decode_event(&self, event: &TxEvent) -> ChainResult<InterchainGasPayment> {
        let igp: Igp = serde_json::from_value(event.value.clone())?;

        Ok(InterchainGasPayment {
            message_id: igp.gas_payment.message_id,
            destination: igp.gas_payment.dest_domain,
            payment: U256::from_dec_str(&igp.gas_payment.payment)?,
            gas_amount: U256::from_dec_str(&igp.gas_payment.gas_limit)?,
        })
    }
}

crate::indexer::impl_indexer_traits!(SovereignInterchainGasPaymasterIndexer, InterchainGasPayment);

/// A struct for the Interchain Gas Paymaster on the Sovereign chain.
#[derive(Debug)]
pub struct SovereignInterchainGasPaymaster {
    domain: HyperlaneDomain,
    address: H256,
    provider: SovereignProvider,
}

impl SovereignInterchainGasPaymaster {
    /// Create a new `SovereignInterchainGasPaymaster`.
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider =
            SovereignProvider::new(locator.domain.clone(), &conf.clone(), signer).await?;
        Ok(SovereignInterchainGasPaymaster {
            domain: locator.domain.clone(),
            provider,
            address: locator.address,
        })
    }
}

impl HyperlaneContract for SovereignInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for SovereignInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl InterchainGasPaymaster for SovereignInterchainGasPaymaster {}
