#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use tracing::instrument;

use hyperlane_core::{
    CcipReadIsm, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, H256,
};

use crate::interfaces::i_ccip_read_ism::ICcipReadIsm as TronCcipReadIsmInternal;
use crate::TronProvider;

/// A reference to a CcipReadIsm contract on some Tron chain
#[derive(Debug)]
pub struct TronCcipReadIsm {
    contract: Arc<TronCcipReadIsmInternal<TronProvider>>,
    domain: HyperlaneDomain,
}

impl TronCcipReadIsm {
    /// Creates a new TronCcipReadIsm instance
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(TronCcipReadIsmInternal::new(
                locator.address,
                Arc::new(provider),
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for TronCcipReadIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.contract.client().clone())
    }
}

impl HyperlaneContract for TronCcipReadIsm {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl CcipReadIsm for TronCcipReadIsm {
    #[instrument(err)]
    async fn get_offchain_verify_info(&self, message: Vec<u8>) -> ChainResult<()> {
        self.contract
            .get_offchain_verify_info(message.into())
            .call()
            .await?;
        Ok(())
    }
}
