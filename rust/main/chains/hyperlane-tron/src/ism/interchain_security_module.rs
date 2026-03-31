#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use tracing::{instrument, warn};

use futures_util::future::try_join;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, Metadata, ModuleType,
    RawHyperlaneMessage, H256, U256,
};
use num_traits::cast::FromPrimitive;

use crate::interfaces::i_interchain_security_module::IInterchainSecurityModule as TronInterchainSecurityModuleInternal;
use crate::interfaces::i_trusted_relayer_ism::ITrustedRelayerIsm;
use crate::TronProvider;

/// A reference to an InterchainSecurityModule contract on some Tron chain
#[derive(Debug)]
pub struct TronInterchainSecurityModule {
    contract: Arc<TronInterchainSecurityModuleInternal<TronProvider>>,
    domain: HyperlaneDomain,
}

impl TronInterchainSecurityModule {
    /// Creates a new TronInterchainSecurityModule instance
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(TronInterchainSecurityModuleInternal::new(
                locator.address,
                Arc::new(provider),
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for TronInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.contract.client().clone())
    }
}

impl HyperlaneContract for TronInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl InterchainSecurityModule for TronInterchainSecurityModule {
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
        let tx = self.contract.verify(
            metadata.to_owned().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        let (verifies, gas_estimate) = try_join(tx.call(), tx.estimate_gas()).await?;
        if verifies {
            return Ok(Some(gas_estimate.into()));
        }
        // For Null-typed ISMs (e.g. TrustedRelayerIsm), verify() returns false
        // during a dry run because it depends on mailbox state set during process().
        // If we are the configured trusted relayer, include it with gas=0.
        if self.module_type().await? == ModuleType::Null {
            if let Some(sender) = self.contract.client().signer_address() {
                let tr = ITrustedRelayerIsm::new(self.contract.address(), self.contract.client());
                if let Ok(trusted_relayer) = tr.trusted_relayer().call().await {
                    if trusted_relayer == sender {
                        return Ok(Some(U256::zero()));
                    }
                }
            }
        }
        Ok(None)
    }
}
