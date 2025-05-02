use crate::{ConnectionConf, Signer};
use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain,
    HyperlaneProvider, TxnInfo, H256, H512, U256,
};

pub mod rest_client;

/// A wrapper around a Sovereign provider to get generic blockchain information.
#[derive(Debug, Clone)]
pub struct SovereignProvider {
    domain: HyperlaneDomain,
    client: rest_client::SovereignRestClient,
    #[allow(dead_code)]
    signer: Option<Signer>,
}

impl SovereignProvider {
    /// Create a new `SovereignProvider`.
    pub async fn new(
        domain: HyperlaneDomain,
        conf: &ConnectionConf,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let client = rest_client::SovereignRestClient::new(conf).await?;

        Ok(Self {
            domain,
            client,
            signer,
        })
    }

    /// Get a rest client.
    pub(crate) fn client(&self) -> &rest_client::SovereignRestClient {
        &self.client
    }
}

impl HyperlaneChain for SovereignProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

// Initial implementation of the Sovereign chain does not include the Scraper as it is not a necessary component for cross chain relaying.
#[async_trait]
impl HyperlaneProvider for SovereignProvider {
    async fn get_block_by_height(&self, _height: u64) -> ChainResult<BlockInfo> {
        Err(ChainCommunicationError::CustomError("Not supported".into()))
    }

    async fn get_txn_by_hash(&self, _hash: &H512) -> ChainResult<TxnInfo> {
        Err(ChainCommunicationError::CustomError("Not supported".into()))
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    async fn get_balance(&self, _address: String) -> ChainResult<U256> {
        Err(ChainCommunicationError::CustomError("Not supported".into()))
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Err(ChainCommunicationError::CustomError("Not supported".into()))
    }
}
