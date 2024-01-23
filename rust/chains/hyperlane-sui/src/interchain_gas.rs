
use std::ops::RangeInclusive;

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta, H256
};
use sui_sdk::types::digests::TransactionDigest;
use tracing::{info, instrument};
use hex;
use crate::{ConnectionConf, SuiHpProvider, SuiRpcClient};
use::sui_sdk::types::base_types::SuiAddress;

/// Format an address to bytes and hex literal. 
pub trait AddressFormatter {
    /// Convert an address to bytes.
    fn to_bytes(&self) -> [u8; 32];
    /// Convert an address to hex literal.
    fn to_hex_literal(&self) -> String;
}

impl AddressFormatter for SuiAddress {
    fn to_bytes(&self) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(self.to_vec().as_slice());
        bytes
    }

    fn to_hex_literal(&self) -> String {
        format!("0x{}", hex::encode(self.to_vec()))
    }
}

/// A reference to an TGP contract on Sui Chain.
#[derive(Debug)]
pub struct SuiInterchainGasPaymaster {
    domain: HyperlaneDomain,
    package_address: SuiAddress,
    sui_client_url: String,
}

impl SuiInterchainGasPaymaster {
    /// Create a new Sui IGP.
    pub fn new(conf: &ConnectionConf, locator: &ContractLocator) -> Self {
        let package_address = 
            SuiAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let sui_client_url = conf.url.to_string();
        Self {
            domain: locator.domain.clone(),
            package_address,
            sui_client_url,
        }
    }
}

impl HyperlaneContract for SuiInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.package_address.to_bytes().into()
    }
}

impl HyperlaneChain for SuiInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
       let sui_provider = tokio::runtime::Runtime::new()
            .expect("Failed to create runtime")
            .block_on(async {
                SuiHpProvider::new(self.domain.clone(), self.sui_client_url.clone()).await
            }).expect("Failed to create SuiHpProvider");
        Box::new(sui_provider) 
    }
}

impl InterchainGasPaymaster for SuiInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sui IGP contract.
#[derive(Debug)]
pub struct SuiInterchainGasPaymasterIndexer {
    sui_client: SuiRpcClient,
    package_address: SuiAddress,
}

impl SuiInterchainGasPaymasterIndexer {
    /// Create a new Sui IGP indexer.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let package_address = 
            SuiAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let sui_client = tokio::runtime::Runtime::new()
            .expect("Failed to create runtime")
            .block_on(async {
                SuiRpcClient::new(conf.url.to_string()).await
            }).expect("Failed to create SuiRpcClient");
        Self {
            sui_client,
            package_address,
        }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SuiInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        digest: TransactionDigest,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        let events = self.sui_client.event_api().get_events(digest).await?;
        Ok(events)
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        // Sui is a DAG-based blockchain and uses checkpoints for node 
        // synchronization and global transaction ordering.
        let latest_checkpoint = self
            .sui_client.read_api().get_latest_checkpoint_sequence_number().await?;
        Ok(latest_checkpoint as u32)
    }
}