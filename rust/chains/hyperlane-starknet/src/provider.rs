use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxnInfo,
    H256, U256,
};
use starknet::accounts::{Account, ExecutionEncoding, SingleOwnerAccount};
use starknet::core::chain_id::{MAINNET, SEPOLIA};
use starknet::providers::jsonrpc::{HttpTransport, JsonRpcClient};
use starknet::providers::AnyProvider;
use tracing::instrument;

use crate::{ConnectionConf, Signer};

#[derive(Debug)]
/// A wrapper over the Starknet provider to provide a more ergonomic interface.
pub struct StarknetProvider<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    domain: HyperlaneDomain,
    rpc_client: Arc<AnyProvider>,
    account: Option<Arc<A>>,
}

impl<A> StarknetProvider<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf, signer: Option<Signer>) -> Self {
        let rpc_client = Arc::new(AnyProvider::JsonRpcHttp(JsonRpcClient::new(
            HttpTransport::new(conf.url.clone()),
        )));

        let chain_id = match domain.id() {
            23448594392895567 => SEPOLIA,
            23448594291968334 => MAINNET,
        };

        let account = if let Some(signer) = signer {
            Some(Arc::new(SingleOwnerAccount::new(
                rpc_client,
                signer.local_wallet(),
                signer.address,
                chain_id,
                ExecutionEncoding::New, // Only supports Cairo 1 accounts
            )))
        } else {
            None
        };

        Self {
            domain,
            rpc_client,
            account,
        }
    }

    pub fn rpc_client(&self) -> Arc<AnyProvider> {
        self.rpc_client
    }

    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    pub fn account(&self) -> Option<Arc<A>> {
        self.account
    }
}

impl<A> HyperlaneChain for StarknetProvider<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(StarknetProvider::new(
            self.provider.clone(),
            self.domain.clone(),
            None,
        ))
    }
}

#[async_trait]
impl<A> HyperlaneProvider for StarknetProvider<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug,
{
    #[instrument(err, skip(self))]
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo> {
        todo!()
    }

    #[instrument(err, skip(self))]
    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo> {
        todo!()
    }

    #[instrument(err, skip(self))]
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        todo!()
    }

    #[instrument(err, skip(self))]
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        todo!()
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        todo!()
    }
}
