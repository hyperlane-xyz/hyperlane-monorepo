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

#[async_trait]
impl HyperlaneProvider for SovereignProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block = self.client.get_block_by_height(height).await?;
        Ok(block)
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let txn = self.client.get_txn_by_hash(hash).await?;
        Ok(txn)
    }

    /// Check if recipient is contract address. Sovereign design deviates from
    /// hyperlane spec in that matter, as hyperlane impl is contract-less, so
    /// we allow any destination here.
    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    async fn get_balance(&self, _address: String) -> ChainResult<U256> {
        Err(ChainCommunicationError::CustomError(
            "Not yet implemented".into(),
        ))
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Err(ChainCommunicationError::CustomError(
            "Not yet implemented".into(),
        ))
    }
}
