use std::fmt::Debug;
use std::time::Instant;

use async_trait::async_trait;
use hyperlane_core::{
    h512_to_bytes, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::{
    ChainInfo as PrometheusChainInfo, ClientConnectionType, PrometheusClientMetrics,
    PrometheusConfig, PrometheusConfigExt,
};
use starknet::core::types::{
    BlockId, BlockTag, Felt, FunctionCall, InvokeTransaction, MaybePendingBlockWithTxHashes,
    Transaction, TransactionReceipt,
};
use starknet::macros::selector;
use starknet::providers::{JsonRpcClient, Provider};
use tracing::instrument;
use url::Url;

use crate::provider::fallback::FallbackHttpTransport;
use crate::types::{HyH256, HyU256};
use crate::{ConnectionConf, HyperlaneStarknetError};

/// JsonProvider type, that includes the fallback behavior
pub type JsonProvider = JsonRpcClient<FallbackHttpTransport>;

/// Builds a new starknet json provider that has fallback behavior
pub(crate) fn build_json_provider(conn: &ConnectionConf) -> JsonProvider {
    JsonRpcClient::new(FallbackHttpTransport::new(conn.urls.clone()))
}

/// Creates metrics configuration for Starknet provider
fn create_metrics_config(conn: &ConnectionConf, chain_name: String) -> Vec<PrometheusConfig> {
    conn.urls
        .iter()
        .map(|url| {
            PrometheusConfig::from_url(
                url,
                ClientConnectionType::Rpc,
                Some(PrometheusChainInfo {
                    name: Some(chain_name.clone()),
                }),
            )
        })
        .collect()
}

#[derive(Debug, Clone)]
/// A wrapper over the Starknet provider to provide a more ergonomic interface.
pub struct StarknetProvider {
    rpc_client: JsonRpcClient<FallbackHttpTransport>,
    domain: HyperlaneDomain,
    fee_token_address: Felt,
    metrics: PrometheusClientMetrics,
    metrics_configs: Vec<PrometheusConfig>,
}

impl StarknetProvider {
    /// Create a new Starknet provider.
    pub fn new(
        domain: HyperlaneDomain,
        conf: &ConnectionConf,
        metrics: PrometheusClientMetrics,
    ) -> Self {
        let provider = JsonRpcClient::new(FallbackHttpTransport::new(conf.urls.clone()));

        // Fee token address is used to check balances
        let fee_token_address = Felt::from_bytes_be(conf.native_token_address.as_fixed_bytes());

        let chain_name = domain.name().to_string();
        let metrics_configs = create_metrics_config(conf, chain_name.clone());

        // Increment provider metrics for each configured provider
        for config in &metrics_configs {
            metrics.increment_provider_instance(&chain_name);
        }

        Self {
            domain,
            rpc_client: provider,
            fee_token_address,
            metrics,
            metrics_configs,
        }
    }

    /// Get the RPC client.
    pub fn rpc_client(&self) -> &JsonRpcClient<FallbackHttpTransport> {
        &self.rpc_client
    }

    /// Get the hyperlane domain.
    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// Track metrics for a provider call
    async fn track_metric_call<F, Fut, T>(&self, method: &str, rpc_call: F) -> ChainResult<T>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = ChainResult<T>>,
    {
        let start = Instant::now();
        let res = rpc_call().await;

        // Track metrics for the first configured provider (representing the fallback group)
        if let Some(config) = self.metrics_configs.first() {
            self.metrics
                .increment_metrics(config, method, start, res.is_ok());
        }

        res
    }
}

impl Drop for StarknetProvider {
    fn drop(&mut self) {
        let chain_name = self.domain.name();
        for _ in &self.metrics_configs {
            self.metrics.decrement_provider_instance(chain_name);
        }
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
        self.track_metric_call("get_block_by_height", || async {
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
        })
        .await
    }

    #[instrument(err, skip(self))]
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        self.track_metric_call("get_txn_by_hash", || async {
            let hash: H256 = H256::from_slice(&h512_to_bytes(hash));
            let tx = self
                .rpc_client()
                .get_transaction_by_hash(Felt::from_bytes_be_slice(hash.as_bytes()))
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?;

            let receipt = self
                .rpc_client()
                .get_transaction_receipt(tx.transaction_hash())
                .await
                .map_err(Into::<HyperlaneStarknetError>::into)?;

            let receipt = match receipt.receipt {
                TransactionReceipt::Invoke(invoke_receipt) => invoke_receipt,
                _ => {
                    return Err(HyperlaneStarknetError::InvalidBlock.into());
                }
            };

            let gas_paid =
                U256::from_big_endian(receipt.actual_fee.amount.to_bytes_be().as_slice());

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
                nonce: nonce.unwrap_or(Felt::ZERO).try_into().unwrap_or(0), // safe to unwrap because we know the nonce fits in a u64
                sender: HyH256::from(sender).0,
                recipient,
                raw_input_data: Some(calldata.into_iter().flat_map(|f| f.to_bytes_be()).collect()),
                receipt: Some(TxnReceiptInfo {
                    gas_used: U256::one(),
                    cumulative_gas_used: U256::one(),
                    effective_gas_price: Some(gas_paid),
                }),
            })
        })
        .await
    }

    #[instrument(err, skip(self))]
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        self.track_metric_call("is_contract", || async { Ok(true) })
            .await
    }

    #[instrument(err, skip(self))]
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.track_metric_call("get_balance", || async {
            let call_result = self
                .rpc_client()
                .call(
                    FunctionCall {
                        contract_address: self.fee_token_address,
                        entry_point_selector: selector!("balanceOf"),
                        calldata: vec![Felt::from_dec_str(&address)
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
        })
        .await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
