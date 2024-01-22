use anyhow::Error;
use hyperlane_core::{ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneProvider, InterchainGasPaymaster, H256};
use crate::{ConnectionConf, SuiHpProvider};
use::sui_sdk::types::base_types::SuiAddress;

trait ToBytes {
    fn to_bytes(&self) -> [u8; 32];
}

impl ToBytes for SuiAddress {
    fn to_bytes(&self) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(self.to_vec().as_slice());
        bytes
    }
}

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
        self.package_address.to_bytes().into()
    }
}

impl HyperlaneChain for SuiInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
       let sui_provider = tokio::runtime::Runtime::new()
            .expect("Failed to create runtime")
            .block_on(async {
                SuiHpProvider::new(self.domain.clone(), self.sui_client_url.clone()).await
            }).expect("Failed to create SuiHpProvider");
        Box::new(sui_provider) 
    }
}

impl InterchainGasPaymaster for SuiInterchainGasPaymaster {}