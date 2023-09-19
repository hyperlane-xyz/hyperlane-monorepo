#![allow(unused)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IndexRange, Indexer, InterchainGasPaymaster,
    InterchainGasPayment, LogMeta, H256,
};
use tracing::{info, instrument};

use crate::{AptosHpProvider, ConnectionConf};

use crate::AptosClient;
use aptos_sdk::types::account_address::AccountAddress;

/// A reference to an IGP contract on some Aptos chain
#[derive(Debug)]
pub struct AptosInterchainGasPaymaster {
    domain: HyperlaneDomain,
    package_address: AccountAddress,
}

impl AptosInterchainGasPaymaster {
    /// Create a new Aptos IGP.
    pub fn new(_conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();

        Self {
            package_address,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for AptosInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.package_address.into_bytes().into()
    }
}

impl HyperlaneChain for AptosInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(AptosHpProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for AptosInterchainGasPaymaster {}

/// Struct that retrieves event data for a Aptos IGP contract
#[derive(Debug)]
pub struct AptosInterchainGasPaymasterIndexer {
    aptos_client: AptosClient,
}

impl AptosInterchainGasPaymasterIndexer {
    /// Create a new Aptos IGP indexer.
    pub fn new(conf: &ConnectionConf, _locator: ContractLocator) -> Self {
        let aptos_client = AptosClient::new(conf.url.to_string());
        Self { aptos_client }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for AptosInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        _range: IndexRange,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        info!("Gas payment indexing not implemented for Aptos");
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
