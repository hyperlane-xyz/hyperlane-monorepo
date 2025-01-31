use std::ops::RangeInclusive;

use async_trait::async_trait;
use fuels::{accounts::wallet::WalletUnlocked, types::bech32::Bech32ContractId};

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256,
};

use crate::{
    contracts::interchain_gas_paymaster::{
        GasPaymentEvent, InterchainGasPaymaster as InterchainGasPaymasterContract,
    },
    conversions::*,
    ConnectionConf, FuelIndexer, FuelProvider,
};

/// A reference to an IGP contract on some Fuel chain
#[derive(Debug)]
pub struct FuelInterchainGasPaymaster {
    contract: InterchainGasPaymasterContract<WalletUnlocked>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelInterchainGasPaymaster {
    /// Create a new fuel IGP contract interface
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelInterchainGasPaymaster {
            contract: InterchainGasPaymasterContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl InterchainGasPaymaster for FuelInterchainGasPaymaster {}

// ----------------------------------------------------------
// ---------------------- Indexer ---------------------------
// ----------------------------------------------------------

/// Struct that retrieves event data for a Fuel IGP contract
#[derive(Debug)]
pub struct FuelInterchainGasPaymasterIndexer {
    indexer: FuelIndexer<GasPaymentEvent>,
}

impl FuelInterchainGasPaymasterIndexer {
    /// Create a new fuel IGP indexer
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let indexer = FuelIndexer::new(conf, locator, wallet).await;
        Ok(Self { indexer })
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for FuelInterchainGasPaymasterIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        self.indexer.index_logs_in_range(range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.indexer.provider().get_finalized_block_number().await
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for FuelInterchainGasPaymasterIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // No sequence for gas payments
        let tip = self.get_finalized_block_number().await?;
        Ok((None, tip))
    }
}
