use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, MultisigIsm, H256,
};

use crate::{ConnectionConf, Signer, SovereignProvider};

/// A struct for the Multisig ISM on the Sovereign chain.
#[derive(Debug)]
pub struct SovereignMultisigIsm {
    domain: HyperlaneDomain,
    address: H256,
    provider: SovereignProvider,
}

impl SovereignMultisigIsm {
    /// Create a new `SovereignMultisigIsm`.
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider =
            SovereignProvider::new(locator.domain.clone(), &conf.clone(), signer).await?;
        Ok(SovereignMultisigIsm {
            domain: locator.domain.clone(),
            provider,
            address: locator.address,
        })
    }
}

impl HyperlaneContract for SovereignMultisigIsm {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for SovereignMultisigIsm {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl MultisigIsm for SovereignMultisigIsm {
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)> {
        let validators = self
            .provider
            .validators_and_threshold(message.recipient)
            .await?;

        Ok(validators)
    }
}
