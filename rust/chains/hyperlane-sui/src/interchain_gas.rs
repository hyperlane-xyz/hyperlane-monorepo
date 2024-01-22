
use hyperlane_core::{ContractLocator, HyperlaneContract, HyperlaneDomain, HyperlaneChain, H256};
use crate::{ConnectionConf, SuiHpProvider};
use::sui_sdk::types::base_types::SuiAddress;

/// A reference to an TGP contract on Sui Chain.
#[derive(Debug)]
pub struct SuiInterchainGasPaymaster {
    domain: HyperlaneDomain,
    package_address: SuiAddress,
    sui_client_url: String,
}

impl SuiInterchainGasPaymaster {
    /// Create a new Sui IGP.
    pub fn new(conf: &ConnectionConf, locator: &ContractLocator) -> Self {
        let package_address = 
            SuiAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let sui_client_url = conf.url.to_string();
        Self {
            domain: locator.domain.clone(),
            package_address,
            sui_client_url,
        }
    }
}

impl HyperlaneContract for SuiInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.package_address.into_bytes().into()
    }
}

impl HyperlaneChain for SuiInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
        Box::new(SuiHpProvider::new(
            self.domain.clone(),
            self.sui_client_url.clone(),
        ))
    }
}