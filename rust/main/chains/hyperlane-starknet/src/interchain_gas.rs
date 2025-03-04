#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;

use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, InterchainGasPaymaster, H256,
};

use crate::{ConnectionConf, StarknetProvider};

/// A reference to a Mailbox contract on some Starknet chain
#[derive(Debug)]
#[allow(unused)]
pub struct StarknetInterchainGasPaymaster {
    conn: ConnectionConf,
    provider: StarknetProvider,
}

impl StarknetInterchainGasPaymaster {
    pub fn new(conn: &ConnectionConf, locator: &ContractLocator) -> ChainResult<Self> {
        Ok(Self {
            provider: StarknetProvider::new(locator.domain.clone(), conn),
            conn: conn.clone(),
        })
    }
}

impl HyperlaneChain for StarknetInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        self.provider.domain()
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

impl HyperlaneContract for StarknetInterchainGasPaymaster {
    fn address(&self) -> H256 {
        H256::zero()
    }
}

#[async_trait]
impl InterchainGasPaymaster for StarknetInterchainGasPaymaster {}

pub struct StarknetInterchainGasPaymasterAbi;

impl HyperlaneAbi for StarknetInterchainGasPaymasterAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        HashMap::default()
    }
}
