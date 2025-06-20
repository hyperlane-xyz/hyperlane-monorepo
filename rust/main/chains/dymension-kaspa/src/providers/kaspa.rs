use std::ops::Deref;

use derive_new::new;
use tonic::async_trait;

use hyperlane_core::{
    rpc_clients::FallbackProvider, BlockInfo, ChainInfo, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxnInfo, H256,
    H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use super::validators::ValidatorsClient;
use super::RestProvider;

use crate::{ConnectionConf, Signer};

/// dococo
#[derive(Debug, Clone)]
pub struct KaspaProvider {
    domain: HyperlaneDomain,
    conf: ConnectionConf,
    rest: RestProvider,
    // TODO: wrpc
    validators: ValidatorsClient,
}

impl KaspaProvider {
    /// dococo
    pub fn new(
        conf: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signer>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let rest = RestProvider::new(conf.clone(), signer, metrics.clone(), chain.clone())?;
        let validators = ValidatorsClient::new(conf.clone())?;

        Ok(KaspaProvider {
            domain: locator.domain.clone(),
            conf: conf.clone(),
            rest,
            validators,
        })
    }

    /// dococo
    pub fn rest(&self) -> &RestProvider {
        &self.rest
    }

    /// dococo
    pub fn validators(&self) -> &ValidatorsClient {
        &self.validators
    }
}

impl HyperlaneChain for KaspaProvider {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for KaspaProvider {
    // only used by scraper
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        Err(HyperlaneProviderError::CouldNotFindBlockByHeight(height).into())
    }

    // only used by scraper
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        return Err(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash).into());
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // TODO: check if the address is a recipient (this is a hyperlane team todo)
        return Ok(true);
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        // TODO: maybe I can return just a larger number here?
        return Ok(0.into());
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}
