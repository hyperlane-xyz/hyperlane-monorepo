use crate::{
    contracts::interchain_security_module::InterchainSecurityModule as InterchainSecurityModuleContract,
    conversions::*, wallet::FuelWallets, ConnectionConf, FuelProvider,
};
use async_trait::async_trait;
use fuels::{
    programs::calls::Execution,
    types::{bech32::Bech32ContractId, Bytes},
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType,
    RawHyperlaneMessage, H256, U256,
};

/// A reference to an ISM contract on some Fuel chain
#[derive(Debug)]
pub struct FuelInterchainSecurityModule {
    contract: InterchainSecurityModuleContract<FuelWallets>,
    domain: HyperlaneDomain,
    provider: FuelProvider,
}

impl FuelInterchainSecurityModule {
    /// Create a new fuel ISM contract interface
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        mut wallet: FuelWallets,
    ) -> ChainResult<Self> {
        let fuel_provider = FuelProvider::new(locator.domain.clone(), conf).await;

        wallet.set_provider(fuel_provider.provider().clone());
        let address = Bech32ContractId::from_h256(&locator.address);

        Ok(FuelInterchainSecurityModule {
            contract: InterchainSecurityModuleContract::new(address, wallet),
            domain: locator.domain.clone(),
            provider: fuel_provider,
        })
    }
}

impl HyperlaneContract for FuelInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.contract.contract_id().into_h256()
    }
}

impl HyperlaneChain for FuelInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl InterchainSecurityModule for FuelInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        if self.address() == H256::zero() {
            return Ok(ModuleType::Null);
        }

        self.contract
            .methods()
            .module_type()
            .simulate(Execution::state_read_only())
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to get module type for ISM contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|res| IsmType(res.value).into())
    }

    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        self.contract
            .methods()
            .verify(
                Bytes(metadata.to_vec()),
                Bytes(RawHyperlaneMessage::from(message)),
            )
            .determine_missing_contracts()
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to get contract dependencies for dry run verify for ISM contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })?
            .simulate(Execution::realistic())
            .await
            .map_err(|e| {
                ChainCommunicationError::from_other_str(
                    format!(
                        "Failed to dry run verify for ISM contract at 0x{:?} - {:?}",
                        self.contract.contract_id().hash,
                        e
                    )
                    .as_str(),
                )
            })
            .map(|res| Some(U256::from(res.tx_status.total_gas)))
    }
}
