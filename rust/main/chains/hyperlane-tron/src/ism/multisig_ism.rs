#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::sync::Arc;

use async_trait::async_trait;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, RawHyperlaneMessage, H256,
};

use crate::interfaces::i_multisig_ism::IMultisigIsm as TronMultisigIsmInternal;
use crate::TronProvider;

/// A reference to an MultisigIsm contract on some Tron chain
#[derive(Debug)]
pub struct TronMultisigIsm {
    contract: Arc<TronMultisigIsmInternal<TronProvider>>,
    domain: HyperlaneDomain,
}

impl TronMultisigIsm {
    /// Create a reference to a mailbox at a specific Tron address on some
    /// chain
    pub fn new(provider: TronProvider, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(TronMultisigIsmInternal::new(
                locator.address,
                Arc::new(provider),
            )),
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneChain for TronMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.contract.client().clone())
    }
}

impl HyperlaneContract for TronMultisigIsm {
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl MultisigIsm for TronMultisigIsm {
    #[instrument(err, skip(self, message))]
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let (validator_addresses, threshold) = self
            .contract
            .validators_and_threshold(RawHyperlaneMessage::from(message).to_vec().into())
            .call()
            .await?;
        let validators: Vec<H256> = validator_addresses.iter().map(|&x| H256::from(x)).collect();
        Ok((validators, threshold))
    }
}
