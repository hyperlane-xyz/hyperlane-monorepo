#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};
use starknet::accounts::SingleOwnerAccount;
use starknet::core::types::Felt;
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;
use tracing::instrument;

use crate::contracts::interchain_security_module::InterchainSecurityModule as StarknetInterchainSecurityModuleInternal;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{
    build_single_owner_account, to_hpl_module_type, ConnectionConf, Signer, StarknetProvider,
};

/// A reference to a ISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetInterchainSecurityModule {
    contract:
        StarknetInterchainSecurityModuleInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetInterchainSecurityModule {
    /// Create a reference to a ISM at a specific Starknet address on some
    /// chain
    pub async fn new(
        conn: &ConnectionConf,
        locator: &ContractLocator<'_>,
        signer: Signer,
    ) -> ChainResult<Self> {
        let account =
            build_single_owner_account(&conn.url, signer.local_wallet(), &signer.address, false)
                .await?;

        let ism_address: Felt = HyH256(locator.address).into();

        let contract = StarknetInterchainSecurityModuleInternal::new(ism_address, account);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }

    #[allow(unused)]
    pub fn contract(
        &self,
    ) -> &StarknetInterchainSecurityModuleInternal<SingleOwnerAccount<AnyProvider, LocalWallet>>
    {
        &self.contract
    }
}

impl HyperlaneChain for StarknetInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetInterchainSecurityModule {
    fn address(&self) -> H256 {
        HyH256::from(self.contract.address).0
    }
}

#[async_trait]
impl InterchainSecurityModule for StarknetInterchainSecurityModule {
    #[instrument(skip(self))]
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module = self
            .contract
            .module_type()
            .call()
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        Ok(to_hpl_module_type(module))
    }

    #[instrument(skip(self))]
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        let message = &message.into();

        // We can't simulate the `verify` call in Starknet because
        // it's not marked as an entrypoint. So we just use the query interface
        // and hardcode a gas value - this can be inefficient if one ISM is
        // vastly cheaper than another one.
        let verified = self
            .contract
            .verify(&metadata.into(), message)
            .call()
            .await
            .map_err(HyperlaneStarknetError::from)?;

        if !verified {
            return Ok(None);
        }

        let dummy_gas_value = U256::one();
        Ok(Some(dummy_gas_value))
    }
}
