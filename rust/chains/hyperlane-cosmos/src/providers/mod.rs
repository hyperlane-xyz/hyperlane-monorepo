use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, ContractLocator, HyperlaneChain, HyperlaneDomain,
    HyperlaneProvider, TxnInfo, H256, U256,
};
use tendermint_rpc::{client::CompatMode, HttpClient};

use crate::{ConnectionConf, CosmosAmount, HyperlaneCosmosError, Signer};

use self::grpc::WasmGrpcProvider;

/// cosmos grpc provider
pub mod grpc;
/// cosmos rpc provider
pub mod rpc;

/// Abstraction over a connection to a Cosmos chain
#[derive(Debug, Clone)]
pub struct CosmosProvider {
    domain: HyperlaneDomain,
    canonical_asset: String,
    grpc_client: WasmGrpcProvider,
    rpc_client: HttpClient,
}

impl CosmosProvider {
    /// Create a reference to a Cosmos chain
    pub fn new(
        domain: HyperlaneDomain,
        conf: ConnectionConf,
        locator: Option<ContractLocator>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let gas_price = CosmosAmount::try_from(conf.get_minimum_gas_price().clone())?;
        let grpc_client = WasmGrpcProvider::new(
            domain.clone(),
            conf.clone(),
            gas_price.clone(),
            locator,
            signer,
        )?;
        let rpc_client = HttpClient::builder(
            conf.get_rpc_url()
                .parse()
                .map_err(Into::<HyperlaneCosmosError>::into)?,
        )
        // Consider supporting different compatibility modes.
        .compat_mode(CompatMode::latest())
        .build()
        .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok(Self {
            domain,
            rpc_client,
            grpc_client,
            canonical_asset: conf.get_canonical_asset(),
        })
    }

    /// Get a grpc client
    pub fn grpc(&self) -> &WasmGrpcProvider {
        &self.grpc_client
    }

    /// Get an rpc client
    pub fn rpc(&self) -> &HttpClient {
        &self.rpc_client
    }
}

impl HyperlaneChain for CosmosProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for CosmosProvider {
    async fn get_block_by_hash(&self, _hash: &H256) -> ChainResult<BlockInfo> {
        todo!() // FIXME
    }

    async fn get_txn_by_hash(&self, _hash: &H256) -> ChainResult<TxnInfo> {
        todo!() // FIXME
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // FIXME
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        Ok(self
            .grpc_client
            .get_balance(address, self.canonical_asset.clone())
            .await?)
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
