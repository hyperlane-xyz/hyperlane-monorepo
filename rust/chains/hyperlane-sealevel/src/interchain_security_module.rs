use async_trait::async_trait;

use hyperlane_core::{
    ChainResult, HyperlaneChain, HyperlaneContract, HyperlaneDomain, H256, ContractLocator, InterchainSecurityModule,
};

use crate::{solana::pubkey::Pubkey, ConnectionConf};

/// A reference to an InterchainSecurityModule contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainSecurityModule {
    program_id: Pubkey,
    domain: HyperlaneDomain,
}

impl SealevelInterchainSecurityModule {
    /// Create a new sealevel InterchainSecurityModule
    pub fn new(
        _conf: &ConnectionConf,
        locator: ContractLocator,
    ) -> Self {
        // TODO use helper functions from mailbox contract lib
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        Self {
            program_id,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(crate::SealevelProvider::new(self.domain.clone()))
    }
}

#[async_trait]
impl InterchainSecurityModule for SealevelInterchainSecurityModule {
    async fn module_type(&self) -> ChainResult<u8> {
        // TODO: actually get this from the chain

        // Legacy multisig
        Ok(3)
    }
}
