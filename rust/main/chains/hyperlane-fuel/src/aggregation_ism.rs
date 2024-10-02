use crate::{
    contracts::aggregation_ism::AggregationISM as AggregationIsmContract, conversions::*,
    ConnectionConf, FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    accounts::wallet::WalletUnlocked,
    types::{bech32::Bech32ContractId, Bytes},
};
use hyperlane_core::{
    AggregationIsm, ChainCommunicationError, ChainResult, ContractLocator, Encode, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, H256,
};

/// A reference to a AggregationIsm contract on some Fuel chain
#[derive(Debug)]
pub struct FuelAggregationIsm {
    contract: AggregationIsmContract<WalletUnlocked>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelAggregationIsm {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelAggregationIsm {
            contract: AggregationIsmContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelAggregationIsm {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelAggregationIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl AggregationIsm for FuelAggregationIsm {
    async fn modules_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        self.contract
            .methods()
            .modules_and_threshold(Bytes(message.to_vec()))
            .call()
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|res| {
                let (modules, threshold) = res.value;
                let modules = modules.iter().map(|v| v.into_h256()).collect();
                (modules, threshold)
            })
    }
}
