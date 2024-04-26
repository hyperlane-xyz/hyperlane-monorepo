use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxnInfo,
    H256, U256,
};
use starknet::core::types::{
    BlockId, BlockTag, FieldElement, FunctionCall, MaybePendingBlockWithTxHashes,
};
use starknet::macros::{felt, selector};
use starknet::providers::jsonrpc::{HttpTransport, JsonRpcClient};
use starknet::providers::{AnyProvider, Provider};
use tracing::instrument;

use crate::{ConnectionConf, HyperlaneStarknetError};

#[derive(Debug, Clone)]
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
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf, account: Option<Arc<A>>) -> Self {
        let rpc_client = Arc::new(AnyProvider::JsonRpcHttp(JsonRpcClient::new(
            HttpTransport::new(conf.url.clone()),
        )));

        Self {
            domain,
            rpc_client,
            account,
        }
    }

    pub fn rpc_client(&self) -> Arc<AnyProvider> {
        self.rpc_client.clone()
    }

    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    pub fn account(&self) -> Option<Arc<A>> {
        self.account.clone()
    }
}

impl<A> HyperlaneChain for &StarknetProvider<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl<A> HyperlaneProvider for &StarknetProvider<A>
where
    A: starknet::accounts::ConnectedAccount + Sync + Send + std::fmt::Debug + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo> {
        let block = self
            .rpc_client()
            .get_block_with_tx_hashes(BlockId::Hash(
                FieldElement::from_bytes_be(hash.as_fixed_bytes())
                    .map_err(Into::<HyperlaneStarknetError>::into)?,
            ))
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;
        match block {
            MaybePendingBlockWithTxHashes::Block(b) => Ok(BlockInfo {
                hash: H256::from_slice(b.block_hash.to_bytes_be().as_slice()),
                timestamp: b.timestamp,
                number: b.block_number,
            }),
            _ => Err(HyperlaneStarknetError::InvalidBlock.into()),
        }
    }

    #[instrument(err, skip(self))]
    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo> {
        let tx = self
            .rpc_client()
            .get_transaction_by_hash(
                FieldElement::from_bytes_be(hash.as_fixed_bytes())
                    .map_err(Into::<HyperlaneStarknetError>::into)?,
            )
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        // TODO: fill with real values
        Ok(TxnInfo {
            hash: H256::from_slice(tx.transaction_hash().to_bytes_be().as_slice()),
            gas_limit: U256::one(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: None,
            nonce: 0,
            sender: H256::zero(),
            recipient: None,
            receipt: None,
        })
    }

    #[instrument(err, skip(self))]
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        todo!()
    }

    #[instrument(err, skip(self))]
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let eth_token_address =
            felt!("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");

        let _call_result = self
            .rpc_client()
            .call(
                FunctionCall {
                    contract_address: eth_token_address,
                    entry_point_selector: selector!("balanceOf"),
                    calldata: vec![FieldElement::from_hex_be(&address).unwrap()],
                },
                BlockId::Tag(BlockTag::Latest),
            )
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        // TODO: We now have to convert it back to a single number using a + (2 ** 128) * b

        Ok(U256::one())
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        todo!()
    }
}
