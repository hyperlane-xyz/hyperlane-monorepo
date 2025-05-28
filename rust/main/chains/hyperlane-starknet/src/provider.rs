use std::fmt::Debug;
use std::sync::Arc;

use async_trait::async_trait;
use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use starknet::core::types::{
    BlockId, BlockTag, FieldElement, FunctionCall, InvokeTransaction,
    MaybePendingBlockWithTxHashes, MaybePendingTransactionReceipt, Transaction, TransactionReceipt,
};
use starknet::macros::{felt, selector};
use starknet::providers::jsonrpc::HttpTransport;
use starknet::providers::{AnyProvider, JsonRpcClient, Provider};
use tracing::instrument;

use crate::types::{HyH256, HyU256};
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
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block = self
            .rpc_client()
            .get_block_with_tx_hashes(BlockId::Number(height))
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
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let hash: H256 = H256::from_slice(&h512_to_bytes(hash));
        let tx = self
            .rpc_client()
            .get_transaction_by_hash(
                FieldElement::from_byte_slice_be(hash.as_bytes())
                    .map_err(Into::<HyperlaneStarknetError>::into)?,
            )
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let receipt = self
            .rpc_client()
            .get_transaction_receipt(tx.transaction_hash())
            .await
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        let receipt = match receipt {
            MaybePendingTransactionReceipt::Receipt(TransactionReceipt::Invoke(invoke_receipt)) => {
                invoke_receipt
            }
            _ => {
                // TODO: better error handling
                return Err(HyperlaneStarknetError::InvalidBlock.into());
            }
        };

        let gas_paid = U256::from_big_endian(receipt.actual_fee.amount.to_bytes_be().as_slice());

        let (nonce, sender, calldata) = match tx.clone() {
            Transaction::Invoke(invoke_tx) => match invoke_tx {
                InvokeTransaction::V0(_) => {
                    return Err(ChainCommunicationError::from_other_str(
                        "V0 invoke transactions are not supported",
                    ))
                }
                InvokeTransaction::V1(invoke_tx) => (
                    Some(invoke_tx.nonce),
                    invoke_tx.sender_address,
                    invoke_tx.calldata,
                ),
                InvokeTransaction::V3(invoke_tx) => (
                    Some(invoke_tx.nonce),
                    invoke_tx.sender_address,
                    invoke_tx.calldata,
                ),
            },
            _ => {
                // We can only parse invoke transactions
                // Other transaction types are not supported and should never be tried to indexed
                return Err(HyperlaneStarknetError::InvalidTransactionReceipt.into());
            }
        };

        // recipient is encoded in the calldata for invoke transactions
        // it is the second element of the calldata
        let recipient = calldata.get(1).map(|f| HyH256::from(*f).0);

        Ok(TxnInfo {
            hash: hash.into(),
            gas_limit: U256::one(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: Some(gas_paid),
            nonce: nonce.unwrap_or(FieldElement::ZERO).try_into().unwrap(), // safe to unwrap because we know the nonce fits in a u64
            sender: HyH256::from(sender).0,
            recipient,
            raw_input_data: Some(calldata.into_iter().flat_map(|f| f.to_bytes_be()).collect()),
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::one(),
                cumulative_gas_used: U256::one(),
                effective_gas_price: Some(gas_paid),
            }),
        })
    }

    #[instrument(err, skip(self))]
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        Ok(true)
    }

    #[instrument(err, skip(self))]
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        // ETH token address
        // cc https://docs.starknet.io/tools/important-addresses/
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

        let balance: HyU256 = (call_result[0], call_result[1])
            .try_into()
            .map_err(Into::<HyperlaneStarknetError>::into)?;

        Ok(balance.0)
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
