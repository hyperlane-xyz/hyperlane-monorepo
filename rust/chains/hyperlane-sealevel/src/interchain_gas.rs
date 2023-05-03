use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ChainCommunicationError, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, H256, Indexer, InterchainGasPaymaster, InterchainGasPaymasterIndexer,
    InterchainGasPayment, LogMeta, HyperlaneProvider,
};
use tracing::warn;

use crate::{
    ConnectionConf,
    solana::{commitment_config::CommitmentConfig, pubkey::Pubkey /*, nonblocking_rpc_client::RpcClient*/}, SealevelProvider,
};

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    // rpc_client: crate::RpcClientWithDebug, // FIXME we don't need a client here?
    domain: HyperlaneDomain,
}

impl SealevelInterchainGasPaymaster {
    pub fn new(_conf: &ConnectionConf /*TODO don't need?*/, locator: ContractLocator) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // let rpc_client = crate::RpcClientWithDebug::new(conf.url.clone());
        Self {
            program_id,
            // rpc_client,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {
    // program_id: Pubkey, // TODO don't need?
    rpc_client: crate::RpcClientWithDebug,
    // domain: HyperlaneDomain, // TODO don't need?
}

impl SealevelInterchainGasPaymasterIndexer {
    pub fn new(conf: &ConnectionConf, _locator: ContractLocator /*TODO don't need?*/) -> Self {
        // let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // let domain = locator.domain;
        let rpc_client = crate::RpcClientWithDebug::new(conf.url.to_string());
        Self {
            // program_id,
            rpc_client,
            // domain,
        }
    }
}

#[async_trait]
impl Indexer for SealevelInterchainGasPaymasterIndexer {
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let height = self
            .rpc_client
            .0
            .get_slot_with_commitment(CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .try_into()
            // FIXME solana block height is u64...
            .expect("sealevel block height exceeds u32::MAX");
        Ok(height)
    }
}

#[async_trait]
impl InterchainGasPaymasterIndexer for SealevelInterchainGasPaymasterIndexer {
    async fn fetch_gas_payments(
        &self,
        _from_block: u32,
        _to_block: u32,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        // FIXME not quite sure what the implemenation here is supposed to be yet given that we
        // selected None for gas payment enforment policy in the config?
        warn!("Reporting no gas payments");
        Ok(vec![])
    }
}
