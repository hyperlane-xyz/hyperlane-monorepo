use crate::{
    contracts::multisig_ism::MultisigISM as MultisigIsmContract, conversions::*,
    wallet::FuelWallets, ConnectionConf, FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    programs::calls::Execution,
    types::{bech32::Bech32ContractId, Bytes},
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, Encode, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, MultisigIsm, H256,
};

/// A reference to a MultisigIsm contract on some Fuel chain
#[derive(Debug)]
pub struct FuelMultisigIsm {
    contract: MultisigIsmContract<FuelWallets>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelMultisigIsm {
    /// Create a new fuel validator announce contract
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: FuelWallets,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelMultisigIsm {
            contract: MultisigIsmContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelMultisigIsm {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl MultisigIsm for FuelMultisigIsm {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        self.contract
            .methods()
            .validators_and_threshold(Bytes(message.to_vec()))
            .simulate(Execution::state_read_only())
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(format!(
                    "Failed to fetch validators and threshold from MultisigIsm contract at 0x{:?} - {:?}",
                    self.contract.contract_id().hash,
                    e
                ).as_str())
            })
            .map(|res| (res.value.0.into_h256_vec(), res.value.1))
    }
}
