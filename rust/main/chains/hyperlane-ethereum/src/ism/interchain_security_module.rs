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
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

pub struct InterchainSecurityModuleBuilder {}

#[async_trait]
impl BuildableWithProvider for InterchainSecurityModuleBuilder {
    type Output = Box<dyn InterchainSecurityModule>;
    const NEEDS_SIGNER: bool = false;

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
        // Null-type ISMs (e.g. TrustedRelayerIsm) check post-delivery state (e.g.
        // mailbox.processor()), so verify() always returns false pre-delivery. Assign
        // gas cost 0 so they are always preferred over heavier sub-ISMs in aggregation.
        if self.module_type().await? == ModuleType::Null {
            return Ok(Some(U256::zero()));
        }
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
            Ok(Some(gas_estimate.into()))
        } else {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod test {
    use std::sync::Arc;

    use ethers::providers::{MockProvider, Provider};
    use ethers_core::{abi, types::Bytes};
    use hyperlane_core::{
        ContractLocator, HyperlaneDomain, HyperlaneMessage, InterchainSecurityModule,
        KnownHyperlaneDomain, Metadata, ModuleType, H256, U256,
    };

    use super::EthereumInterchainSecurityModule;

    fn get_test_ism(
        domain: HyperlaneDomain,
    ) -> (
        EthereumInterchainSecurityModule<Provider<Arc<MockProvider>>>,
        Arc<MockProvider>,
    ) {
        let mock_provider = Arc::new(MockProvider::new());
        let provider = Arc::new(Provider::new(mock_provider.clone()));
        let ism = EthereumInterchainSecurityModule::new(
            provider,
            &ContractLocator {
                domain: &domain,
                // Address doesn't matter because we're using a MockProvider
                address: H256::default(),
            },
        );
        (ism, mock_provider)
    }

    /// Verifies that dry_run_verify returns Ok(Some(U256::zero())) for Null-type ISMs
    /// (e.g. TrustedRelayerIsm) without calling verify(), since verify() always returns
    /// false pre-delivery (mailbox.processor() state check).
    #[tokio::test]
    async fn test_dry_run_verify_null_ism_returns_zero_gas() {
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
        let (ism, mock_provider) = get_test_ism(domain);

        // MockProvider responses are LIFO — only module_type() is called; verify() is not.
        // ABI-encode uint8(6) = ModuleType::Null as a 32-byte padded value.
        let encoded = Bytes::from(abi::encode(&[abi::Token::Uint(
            (ModuleType::Null as u8).into(),
        )]));
        mock_provider.push::<Bytes, _>(encoded).unwrap();

        let result = ism
            .dry_run_verify(&HyperlaneMessage::default(), &Metadata::new(vec![]))
            .await
            .unwrap();

        assert_eq!(result, Some(U256::zero()));
    }
}

pub struct EthereumInterchainSecurityModuleAbi;

impl HyperlaneAbi for EthereumInterchainSecurityModuleAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IINTERCHAINSECURITYMODULE_ABI)
    }
}
