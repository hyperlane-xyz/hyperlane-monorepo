use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    InterchainSecurityModule, ModuleType, H256, U256,
};

type ResponseList<T> = Arc<Mutex<VecDeque<T>>>;

#[derive(Debug, Default)]
pub struct MockInterchainSecurityModuleResponses {
    pub dry_run_verify: ResponseList<ChainResult<Option<U256>>>,
}

pub struct MockInterchainSecurityModule {
    pub address: H256,
    pub domain: HyperlaneDomain,
    pub module_type: ModuleType,
    pub responses: MockInterchainSecurityModuleResponses,
}

impl std::fmt::Debug for MockInterchainSecurityModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "MockInterchainSecurityModule {{ address: {} }}",
            self.address
        )
    }
}

impl MockInterchainSecurityModule {
    pub fn new(address: H256, domain: HyperlaneDomain, module_type: ModuleType) -> Self {
        Self {
            address,
            domain,
            module_type,
            responses: MockInterchainSecurityModuleResponses::default(),
        }
    }
}

#[async_trait::async_trait]
impl InterchainSecurityModule for MockInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        Ok(self.module_type)
    }

    /// Dry runs the `verify()` ISM call and returns `Some(gas_estimate)` if the call
    /// succeeds.
    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        self.responses
            .dry_run_verify
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("No mock dry_run_verify response set {}", self.address))
    }
}

impl HyperlaneContract for MockInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for MockInterchainSecurityModule {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::KnownHyperlaneDomain;

    use crate::test_utils::mock_ism::MockInterchainSecurityModule;

    use super::*;

    /// Just to test mock structs work
    #[tokio::test]
    async fn test_mock_works() {
        let mock_ism = MockInterchainSecurityModule::new(
            H256::zero(),
            HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            ModuleType::Routing,
        );
        let module_type = mock_ism.module_type().await.expect("No response");
        assert_eq!(module_type, ModuleType::Routing);
    }
}
