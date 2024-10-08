use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    BlockInfo, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, TxnInfo,
    TxnReceiptInfo, H256, U256,
};
use starknet::core::types::{
    BlockId, BlockTag, FieldElement, FunctionCall, MaybePendingBlockWithTxHashes,
    MaybePendingTransactionReceipt, TransactionReceipt,
};
use starknet::macros::{felt, selector};
use starknet::providers::jsonrpc::HttpTransport;
use starknet::providers::{AnyProvider, JsonRpcClient, Provider};
use tracing::instrument;

use crate::{ConnectionConf, HyperlaneStarknetError};

#[derive(Debug, Clone)]
/// A wrapper over the Starknet provider to provide a more ergonomic interface.
pub struct StarknetProvider {
    rpc_client: Arc<AnyProvider>,
    domain: HyperlaneDomain,
}

impl StarknetProvider {
    /// Create a new Starknet provider.
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        let provider =
            AnyProvider::JsonRpcHttp(JsonRpcClient::new(HttpTransport::new(conf.url.clone())));

        Self {
            domain,
            rpc_client: Arc::new(provider),
        }
    }

    /// Get the RPC client.
    pub fn rpc_client(&self) -> Arc<AnyProvider> {
        self.rpc_client.clone()
    }

    /// Get the hyperlane domain.
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }
}

impl HyperlaneChain for StarknetProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for StarknetProvider {
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

        let receipt = self
            .rpc_client()
            .get_transaction_receipt(tx.transaction_hash())
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        match receipt {
            MaybePendingTransactionReceipt::Receipt(tx_receipt) => match tx_receipt {
                TransactionReceipt::Invoke(invoke_receipt) => Ok(TxnInfo {
                    hash: H256::from_slice(tx.transaction_hash().to_bytes_be().as_slice()),
                    gas_limit: U256::one(),
                    max_priority_fee_per_gas: None,
                    max_fee_per_gas: None,
                    gas_price: None,
                    nonce: 0,
                    sender: H256::zero(),
                    recipient: None,
                    receipt: Some(TxnReceiptInfo {
                        gas_used: U256::from_big_endian(
                            invoke_receipt.actual_fee.amount.to_bytes_be().as_slice(),
                        ),
                        cumulative_gas_used: U256::zero(),
                        effective_gas_price: None,
                    }),
                }),
                _ => Err(HyperlaneStarknetError::InvalidBlock.into()),
            },
            _ => Err(HyperlaneStarknetError::InvalidBlock.into()),
        }
    }

    #[instrument(err, skip(self))]
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    #[instrument(err, skip(self))]
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let eth_token_address =
            felt!("0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7");

        let call_result = self
            .rpc_client()
            .call(
                FunctionCall {
                    contract_address: eth_token_address,
                    entry_point_selector: selector!("balanceOf"),
                    calldata: vec![FieldElement::from_dec_str(&address)
                        .map_err(Into::<HyperlaneStarknetError>::into)?],
                },
                BlockId::Tag(BlockTag::Latest),
            )
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let balance: U256 = (call_result[0], call_result[1])
            .try_into()
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(balance)
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
