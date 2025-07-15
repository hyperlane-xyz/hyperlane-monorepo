#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};
use starknet::core::types::Felt;
use tracing::instrument;

use crate::contracts::interchain_security_module::InterchainSecurityModuleReader;
use crate::error::HyperlaneStarknetError;
use crate::types::HyH256;
use crate::{
    build_json_provider, to_hpl_module_type, ConnectionConf, JsonProvider, StarknetProvider,
};

/// A reference to a ISM contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetInterchainSecurityModule {
    contract: InterchainSecurityModuleReader<JsonProvider>,
    provider: StarknetProvider,
    conn: ConnectionConf,
}

impl StarknetInterchainSecurityModule {
    /// Create a reference to a ISM at a specific Starknet address on some
    /// chain
    pub fn new(conn: &ConnectionConf, locator: &ContractLocator<'_>) -> ChainResult<Self> {
        let provider = build_json_provider(conn);
        let ism_address: Felt = HyH256(locator.address).into();
        let contract = InterchainSecurityModuleReader::new(ism_address, provider);

        Ok(Self {
            contract,
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
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
        // let message = &message.into();

        // let calldata = self.contract.verify(&metadata.into(), message);
        // debug!("Dry run verify call data: {:#?}", calldata.call_raw);
        // // We can't simulate the `verify` call in Starknet because
        // // it's not marked as an entrypoint. So we just use the query interface
        // // and hardcode a gas value - this can be inefficient if one ISM is
        // // vastly cheaper than another one.
        // let verified = calldata.call().await.map_err(HyperlaneStarknetError::from);
        // debug!("Dry run verify call result: {:#?}", verified);

        // let verified = verified?;

        // if !verified {
        //     return Ok(None);
        // }

        // let dummy_gas_value = U256::one();
        // Ok(Some(dummy_gas_value))

        //TODO: investiage why this method fails for paradex mainnet only
        // it seems as if metadata or message incorrect when this method is called from `cheapest_valid_metas`

        Ok(Some(U256::one()))
    }
}
