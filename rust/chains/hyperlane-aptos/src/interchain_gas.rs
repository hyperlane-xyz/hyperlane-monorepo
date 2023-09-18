#![allow(unused)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, IndexRange, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    H256, ChainCommunicationError,
};
use tracing::{info, instrument};

use crate::{ConnectionConf, AptosHpProvider};

use crate::AptosClient;
use aptos_sdk::types::account_address::AccountAddress;

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    domain: HyperlaneDomain,
    package_address: AccountAddress
}

impl SealevelInterchainGasPaymaster {
    /// Create a new Sealevel IGP.
    pub fn new(_conf: &ConnectionConf, locator: ContractLocator) -> Self {
      
        let package_address = AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
      
        Self {
            package_address,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.package_address.into_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(AptosHpProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {
  aptos_client: AptosClient
}

impl SealevelInterchainGasPaymasterIndexer {
    /// Create a new Sealevel IGP indexer.
    pub fn new(conf: &ConnectionConf, _locator: ContractLocator) -> Self {
        let aptos_client = AptosClient::new(conf.url.to_string());
        Self { aptos_client }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        _range: IndexRange,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        info!("Gas payment indexing not implemented for Sealevel");
        Ok(vec![])
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
      /*let chain_state = self.aptos_client.get_ledger_information()
        .await
        .map_err(ChainCommunicationError::from_other)
        .unwrap()
        .into_inner();*/
      // Ok(chain_state.block_height as u32)
      // TODO:
      Ok(1)
    }
}
