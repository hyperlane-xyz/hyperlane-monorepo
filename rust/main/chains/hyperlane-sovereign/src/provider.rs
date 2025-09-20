use std::ops::Deref;

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain,
    HyperlaneProvider, TxnInfo, H256, H512, U256,
};

mod client;
mod methods;
mod transaction;

use crate::{ConnectionConf, Signer};
pub use client::SovereignClient;

/// A wrapper around a Sovereign provider to get generic blockchain information.
#[derive(Debug, Clone)]
pub struct SovereignProvider {
    domain: HyperlaneDomain,
    client: SovereignClient,
}

impl SovereignProvider {
    /// Create a new `SovereignProvider`.
    pub async fn new(
        domain: HyperlaneDomain,
        conf: &ConnectionConf,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let signer = signer.ok_or(ChainCommunicationError::SignerUnavailable)?;
        let client = SovereignClient::new(conf, signer).await?;

        Ok(Self { domain, client })
    }
}

impl Deref for SovereignProvider {
    type Target = SovereignClient;

    fn deref(&self) -> &Self::Target {
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
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let slot = self.get_specified_slot(height).await?;
        Ok(BlockInfo {
            hash: slot.hash,
            number: slot.number,
            timestamp: slot.timestamp,
        })
    }

    /// The transaction info returned by the sovereign node doesn't have enough data
    /// to properly fill in the [`TxnInfo`], thus calling this will result in an error.
    async fn get_txn_by_hash(&self, _hash: &H512) -> ChainResult<TxnInfo> {
        Err(custom_err!("Not supported"))
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.client.get_balance(&address).await
    }

    /// Sovereign sdk uses multidimensional gas price, so we have to return `None` for
    /// the `min_gas_price`.
    ///
    /// <https://sovereign-labs.github.io/sdk-contributors/gas.html>
    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let latest_slot = self.get_latest_slot().await?;

        Ok(Some(ChainInfo {
            latest_block: self.get_block_by_height(latest_slot).await?,
            min_gas_price: None,
        }))
    }
}
