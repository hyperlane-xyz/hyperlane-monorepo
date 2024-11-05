use crate::{
    contracts::routing_ism::RoutingISM as RoutingISMContract, conversions::*, ConnectionConf,
    FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    accounts::wallet::WalletUnlocked,
    programs::calls::Execution,
    types::{bech32::Bech32ContractId, Bytes},
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Encode, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, RoutingIsm, H256,
};

/// A reference to a RoutingIsm contract on some Fuel chain
#[derive(Debug)]
pub struct FuelRoutingIsm {
    contract: RoutingISMContract<WalletUnlocked>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelRoutingIsm {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: WalletUnlocked,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelRoutingIsm {
            contract: RoutingISMContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelRoutingIsm {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelRoutingIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl RoutingIsm for FuelRoutingIsm {
    /// Returns the ism needed to verify message
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        self.contract
            .methods()
            .route(Bytes(message.to_vec()))
            .determine_missing_contracts(Some(10))
            .await
            .map_err(ChainCommunicationError::from_other)?
            .simulate(Execution::StateReadOnly)
            .await
            .map_err(ChainCommunicationError::from_other)
            .map(|res| res.value.into_h256())
    }
}
