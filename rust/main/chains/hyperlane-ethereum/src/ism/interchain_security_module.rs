#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use ethers_core::abi::ethereum_types::H160;
use tracing::{instrument, warn};

use futures_util::future::try_join;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, Metadata, ModuleType,
    RawHyperlaneMessage, H256, U256,
};
use num_traits::cast::FromPrimitive;

use crate::interfaces::i_interchain_security_module::{
    IInterchainSecurityModule as EthereumInterchainSecurityModuleInternal,
    IINTERCHAINSECURITYMODULE_ABI,
};
use crate::interfaces::i_routing_ism::IRoutingIsm;
use crate::interfaces::i_trusted_relayer_ism::ITrustedRelayerIsm;
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

pub struct InterchainSecurityModuleBuilder {}

#[async_trait]
impl BuildableWithProvider for InterchainSecurityModuleBuilder {
    type Output = Box<dyn InterchainSecurityModule>;
    const NEEDS_SIGNER: bool = true;

    fn uses_ethers_submission_middleware(&self) -> bool {
        false
    }

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumInterchainSecurityModule::new(
            Arc::new(provider),
            locator,
        ))
    }
}

/// A reference to an InterchainSecurityModule contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumInterchainSecurityModule<M>
where
    M: Middleware,
{
    contract: Arc<EthereumInterchainSecurityModuleInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumInterchainSecurityModuleInternal::new(
                locator.address,
                provider,
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

// The address 0x69BE704F62F7CbC1a30E35E0153D89e2b0A6Aa55 as a byte array.
// This address was randomly generated in order to estimate gas better than
// using a fixed address like repeating the 0xab byte, as required by ZkSync chains.
// This is due to some compression optimizations that ZkSync does when an address is low entropy.
const RANDOM_ADDRESS: H160 = H160([
    0x69, 0xBE, 0x70, 0x4F, 0x62, 0xF7, 0xCB, 0xC1, 0xA3, 0x0E, 0x35, 0xE0, 0x15, 0x3D, 0x89, 0xE2,
    0xB0, 0xA6, 0xAA, 0x55,
]);

// ISM routing chains are shallow in practice; this cap prevents infinite loops from
// cycles or pathological on-chain configurations.
const MAX_ISM_ROUTING_DEPTH: usize = 10;

impl<M> EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    async fn dry_run_verify_inner(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
        routing_depth: usize,
    ) -> ChainResult<Option<U256>> {
        let mut tx = self.contract.verify(
            metadata.to_owned().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        if self.domain.is_zksync_stack() {
            // We use a random from address to ensure compatibility with zksync,
            // but intentionally do not set this for other chains which may have assumptions
            // around the presence of funds in the from address (which defaults to address(0)).
            // Context here: https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/4585
            tx = tx.from(RANDOM_ADDRESS);
        }
        let (verifies, gas_estimate) = try_join(tx.call(), tx.estimate_gas()).await?;
        if verifies {
            return Ok(Some(gas_estimate.into()));
        }
        let module_type = self.module_type().await?;
        // For Null-typed ISMs (e.g. TrustedRelayerIsm), verify() returns false
        // during a dry run because it depends on mailbox state set during process().
        // If we are the configured trusted relayer, include it with gas=0.
        if module_type == ModuleType::Null {
            if let Some(sender) = self.contract.client().default_sender() {
                let tr = ITrustedRelayerIsm::new(self.contract.address(), self.contract.client());
                if let Ok(trusted_relayer) = tr.trusted_relayer().call().await {
                    if trusted_relayer == sender {
                        return Ok(Some(U256::zero()));
                    }
                }
            }
        }
        // For Routing ISMs (e.g. AmountRoutingIsm), verify() always returns false during a dry
        // run because the sub-ISM is not directly called. Route the message to the appropriate
        // sub-ISM and recurse so that e.g. a TrustedRelayerIsm sub-ISM can be discovered.
        if module_type == ModuleType::Routing {
            if routing_depth >= MAX_ISM_ROUTING_DEPTH {
                warn!(
                    routing_depth,
                    "Max ISM routing depth reached in dry_run_verify"
                );
                return Ok(None);
            }
            let routing = IRoutingIsm::new(self.contract.address(), self.contract.client());
            let raw_message: ethers::types::Bytes =
                RawHyperlaneMessage::from(message).to_vec().into();
            if let Ok(routed_address) = routing.route(raw_message).call().await {
                let locator = ContractLocator {
                    domain: &self.domain,
                    address: routed_address.into(),
                };
                let routed_ism =
                    EthereumInterchainSecurityModule::new(self.contract.client(), &locator);
                if let Ok(result) = routed_ism
                    .dry_run_verify_inner(message, metadata, routing_depth + 1)
                    .await
                {
                    return Ok(result);
                }
            }
        }
        Ok(None)
    }
}

#[async_trait]
impl<M> InterchainSecurityModule for EthereumInterchainSecurityModule<M>
where
    M: Middleware + 'static,
{
    #[instrument]
    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module = self.contract.module_type().call().await?;
        if let Some(module_type) = ModuleType::from_u8(module) {
            Ok(module_type)
        } else {
            warn!(%module, "Unknown module type");
            Ok(ModuleType::Unused)
        }
    }

    #[instrument]
    async fn dry_run_verify(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<Option<U256>> {
        self.dry_run_verify_inner(message, metadata, 0).await
    }
}

pub struct EthereumInterchainSecurityModuleAbi;

impl HyperlaneAbi for EthereumInterchainSecurityModuleAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IINTERCHAINSECURITYMODULE_ABI)
    }
}
