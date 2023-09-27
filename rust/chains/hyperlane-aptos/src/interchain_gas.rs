#![allow(unused)]

use std::ops::RangeInclusive;

use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, Indexer, InterchainGasPaymaster, InterchainGasPayment,
    LogMeta, SequenceIndexer, H256,
};
use tracing::{info, instrument};

use crate::{get_filtered_events, AptosHpProvider, ConnectionConf, GasPaymentEventData};

use crate::AptosClient;
use aptos_sdk::types::account_address::AccountAddress;

/// A reference to an IGP contract on some Aptos chain
#[derive(Debug)]
pub struct AptosInterchainGasPaymaster {
    domain: HyperlaneDomain,
    package_address: AccountAddress,
    aptos_client_url: String,
}

impl AptosInterchainGasPaymaster {
    /// Create a new Aptos IGP.
    pub fn new(conf: &ConnectionConf, locator: &ContractLocator) -> Self {
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let aptos_client_url = conf.url.to_string();
        Self {
            package_address,
            domain: locator.domain.clone(),
            aptos_client_url,
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
        Box::new(AptosHpProvider::new(
            self.domain.clone(),
            self.aptos_client_url.clone(),
        ))
    }
}

impl InterchainGasPaymaster for AptosInterchainGasPaymaster {}

/// Struct that retrieves event data for a Aptos IGP contract
#[derive(Debug)]
pub struct AptosInterchainGasPaymasterIndexer {
    aptos_client: AptosClient,
    package_address: AccountAddress,
}

impl AptosInterchainGasPaymasterIndexer {
    /// Create a new Aptos IGP indexer.
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> Self {
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let aptos_client = AptosClient::new(conf.url.to_string());
        Self {
            aptos_client,
            package_address,
        }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for AptosInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        get_filtered_events::<InterchainGasPayment, GasPaymentEventData>(
            &self.aptos_client,
            self.package_address,
            &format!("{}::igps::IgpState", self.package_address.to_hex_literal()),
            "gas_payment_events",
            range,
        )
        .await
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let chain_state = self
            .aptos_client
            .get_ledger_information()
            .await
            .map_err(ChainCommunicationError::from_other)
            .unwrap()
            .into_inner();
        Ok(chain_state.block_height as u32)
    }
}

#[async_trait]
impl SequenceIndexer<InterchainGasPayment> for AptosInterchainGasPaymasterIndexer {
    async fn sequence_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
