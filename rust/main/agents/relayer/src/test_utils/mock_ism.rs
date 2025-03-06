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
    pub module_type: ResponseList<ChainResult<ModuleType>>,
    pub dry_run_verify: ResponseList<ChainResult<Option<U256>>>,
    pub domain: Option<HyperlaneDomain>,
}

#[derive(Debug, Default)]
pub struct MockInterchainSecurityModule {
    pub responses: MockInterchainSecurityModuleResponses,
}

#[async_trait::async_trait]
impl InterchainSecurityModule for MockInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<ModuleType> {
        self.responses
            .module_type
            .lock()
            .unwrap()
            .pop_front()
            .expect("No mock module_type response set")
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
            .expect("No mock dry_run_verify response set")
    }
}

impl HyperlaneContract for MockInterchainSecurityModule {
    fn address(&self) -> H256 {
        H256::zero()
    }
}

impl HyperlaneChain for MockInterchainSecurityModule {
    fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
        self.responses
            .domain
            .as_ref()
            .expect("No mock domain response set")
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        unimplemented!()
    }
}

#[cfg(test)]
mod tests {
    use crate::test_utils::mock_ism::MockInterchainSecurityModule;

    use super::*;

    /// Just to test mock structs work
    #[tokio::test]
    async fn test_mock_works() {
        let mock_ism = MockInterchainSecurityModule::default();
        mock_ism
            .responses
            .module_type
            .lock()
            .unwrap()
            .push_back(Ok(ModuleType::Routing));
        mock_ism
            .responses
            .module_type
            .lock()
            .unwrap()
            .push_back(Ok(ModuleType::Aggregation));

        let module_type = mock_ism.module_type().await.expect("No response");
        assert_eq!(module_type, ModuleType::Routing);

        let module_type = mock_ism.module_type().await.expect("No response");
        assert_eq!(module_type, ModuleType::Aggregation);
    }
}
