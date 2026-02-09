use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::abi::Address;
use ethers::contract::builders::ContractCall;
use ethers::providers::Provider;
use ethers::providers::{Middleware, ProviderError};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{BlockId, Bytes, H160};
use ethers_signers::Signer;
use hyperlane_core::utils::hex_or_base58_or_bech32_to_h256;
use num::ToPrimitive;
use tracing::{debug, instrument};

use hyperlane_core::{
    ethers_core_types, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxOutcome, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::{self, PrometheusClientMetrics};

use crate::provider::base::TronBaseHttpClient;
use crate::provider::fallback::TronFallbackHttpClient;
use crate::provider::traits::{TronRpcClient, TronTransaction, TxParams};
use crate::{
    build_fallback_provider, ConnectionConf, HyperlaneTronError, JsonProvider, TronSigner,
    DEFAULT_ENERGY_MULTIPLIER,
};

/// Tron address prefix byte
const ADDRESS_PREFIX: u8 = 0x41;

/// Tron Provider
#[derive(Clone, Debug)]
pub struct TronProvider {
    rest: TronRpcClient<TronFallbackHttpClient>,
    jsonrpc: Arc<Provider<JsonProvider>>,
    domain: HyperlaneDomain,
    signer: Option<TronSigner>,
    energy_multiplier: f64,
}

impl TronProvider {
    /// New TronProvider
    pub fn new(
        conf: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<TronSigner>,
        metrics: PrometheusClientMetrics,
        chain: Option<prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let rest_fallback = TronFallbackHttpClient::new::<TronBaseHttpClient>(
            conf.rpc_urls.clone(),
            metrics.clone(),
            chain.clone(),
        )?;
        let rest = TronRpcClient::new(rest_fallback);
        let jsonrpc = build_fallback_provider(&conf.rpc_urls, metrics, chain)?;

        Ok(Self {
            rest,
            jsonrpc: Arc::new(Provider::new(jsonrpc)),
            domain: locator.domain.clone(),
            signer,
            energy_multiplier: conf.energy_multiplier.unwrap_or(DEFAULT_ENERGY_MULTIPLIER),
        })
    }

    fn get_signer(&self) -> ChainResult<&TronSigner> {
        Ok(self
            .signer
            .as_ref()
            .ok_or(HyperlaneTronError::MissingSigner)?)
    }

    /// Parse a TypedTransaction into hex-string params for the REST API
    fn parse_tx_params(&self, tx: &TypedTransaction) -> TxParams {
        let (mut owner, to, value, data) = match &tx {
            TypedTransaction::Legacy(tx) => {
                let owner = tx.from.unwrap_or_default();
                let to = tx
                    .to
                    .clone()
                    .and_then(|x| x.as_address().cloned())
                    .unwrap_or(H160::zero());
                let value = tx.value.unwrap_or_default();
                let data = tx.data.clone().unwrap_or_default();

                (owner, to, value, data)
            }
            TypedTransaction::Eip2930(request) => {
                let tx = request.tx.clone();
                let owner = tx.from.unwrap_or_default();
                let to = tx
                    .to
                    .and_then(|x| x.as_address().cloned())
                    .unwrap_or(H160::zero());
                let value = tx.value.unwrap_or_default();
                let data = tx.data.unwrap_or_default();

                (owner, to, value, data)
            }
            TypedTransaction::Eip1559(tx) => {
                let owner = tx.from.unwrap_or_default();
                let to = tx
                    .to
                    .clone()
                    .and_then(|x| x.as_address().cloned())
                    .unwrap_or(H160::zero());
                let value = tx.value.unwrap_or_default();
                let data = tx.data.clone().unwrap_or_default();

                (owner, to, value, data)
            }
        };

        // If owner is zero address, use signer's address if available
        if owner.is_zero() {
            if let Some(signer) = &self.signer {
                owner = signer.address();
            }
        }

        // NOTE: Tron addresses need to be prefixed with a byte 0x41
        TxParams {
            owner_hex: hex::encode([&[ADDRESS_PREFIX], owner.as_bytes()].concat()),
            contract_hex: hex::encode([&[ADDRESS_PREFIX], to.as_bytes()].concat()),
            data_hex: hex::encode(&data),
            call_value: value.as_u64(),
        }
    }

    /// Get the current block
    async fn get_current_block(&self) -> ChainResult<crate::provider::traits::BlockResponse> {
        self.rest.get_now_block().await
    }

    /// Get finalized block number
    pub async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let block = self.get_current_block().await?;
        Ok(block.block_header.raw_data.number as u32)
    }

    /// Send transaction and wait for confirmation
    pub async fn send_and_wait<R: std::fmt::Debug>(
        &self,
        call: &ContractCall<Self, R>,
    ) -> ChainResult<TxOutcome> {
        let hash = self.submit_tx(&call.tx).await?;

        // Timeout delay is the total amount of seconds to wait before we call a timeout
        const TIMEOUT_DELAY: u64 = 30;
        const POLLING_INTERVAL: u64 = 2;
        const NUM_RETRIES: usize = (TIMEOUT_DELAY / POLLING_INTERVAL) as usize;
        let mut attempt: usize = 0;

        let receipt = loop {
            let result = self.jsonrpc.get_transaction_receipt(hash).await?;
            match result {
                Some(receipt) => break Ok::<_, ChainCommunicationError>(receipt),
                _ => {
                    debug!("Transaction still pending, continuing to poll: {hash} {attempt}",);
                    // Transaction is still pending, continue polling
                    attempt = attempt.saturating_add(1);
                    if attempt >= NUM_RETRIES {
                        return Err(ChainCommunicationError::from_other_str(&format!(
                            "Transaction timed out after {TIMEOUT_DELAY} seconds"
                        )));
                    }
                    tokio::time::sleep(Duration::from_secs(POLLING_INTERVAL)).await;
                    continue;
                }
            }
        }?;

        Ok(receipt.into())
    }

    /// Send transaction
    pub async fn submit_tx(&self, tx: &TypedTransaction) -> ChainResult<H256> {
        let energy_price = self.jsonrpc.get_gas_price().await?;
        let energy_estimate = match tx.gas() {
            Some(gas) => gas,
            None => &self.estimate_gas(tx, None).await?,
        };
        let fee_limit = energy_estimate.saturating_mul(energy_price).as_u64();
        let fee_limit = (fee_limit as f64 * self.energy_multiplier)
            .to_u64()
            .unwrap_or(u64::MAX);

        let params = self.parse_tx_params(tx);

        let result = self
            .rest
            .trigger_smart_contract(
                &params.owner_hex,
                &params.contract_hex,
                &params.data_hex,
                params.call_value,
                fee_limit,
            )
            .await?;

        let tx_id_bytes = hex::decode(&result.transaction.tx_id)
            .map_err(|e| HyperlaneTronError::RestApiError(format!("bad txID hex: {e}")))?;
        let hash = H256::from_slice(&tx_id_bytes);

        let signer = self.get_signer()?;
        let signature = signer.sign_hash(hash.into());

        self.broadcast_transaction(&result.transaction, signature.to_vec())
            .await?;

        Ok(hash)
    }

    /// Broadcast a signed transaction via REST API
    pub async fn broadcast_transaction(
        &self,
        transaction: &TronTransaction,
        signature: Vec<u8>,
    ) -> ChainResult<()> {
        let result = self
            .rest
            .broadcast_transaction(transaction, signature)
            .await?;

        match result.result {
            Some(true) => Ok(()),
            _ => {
                let message = format!(
                    "Failed to broadcast transaction: code={}, message={}",
                    result.code.as_deref().unwrap_or("unknown"),
                    result.message.as_deref().unwrap_or("unknown"),
                );
                Err(HyperlaneTronError::BroadcastTransactionError(message).into())
            }
        }
    }

    fn get_block_info(block: &crate::provider::traits::BlockResponse) -> ChainResult<BlockInfo> {
        let hash = H256::from_str(&block.block_id)?;

        Ok(BlockInfo {
            hash,
            timestamp: block
                .block_header
                .raw_data
                .timestamp
                .checked_div(1000)
                .unwrap_or_default(),
            number: block.block_header.raw_data.number,
        })
    }
}

#[async_trait]
impl Middleware for TronProvider {
    type Error = ProviderError;
    type Provider = JsonProvider;
    type Inner = Provider<JsonProvider>;

    fn inner(&self) -> &Self::Inner {
        &self.jsonrpc
    }

    async fn call(
        &self,
        tx: &TypedTransaction,
        _block: Option<BlockId>,
    ) -> Result<Bytes, Self::Error> {
        let params = self.parse_tx_params(tx);

        let result = self
            .rest
            .trigger_constant_contract(&params.owner_hex, &params.contract_hex, &params.data_hex)
            .await
            .map_err(|e| ProviderError::CustomError(e.to_string()))?;

        let data = result
            .constant_result
            .first()
            .ok_or_else(|| {
                ProviderError::CustomError(
                    "No constant result returned from trigger_constant_contract".into(),
                )
            })?
            .clone();

        let bytes = hex::decode(&data)
            .map_err(|e| ProviderError::CustomError(format!("hex decode error: {e}")))?;
        Ok(Bytes::from(bytes))
    }

    async fn estimate_gas(
        &self,
        tx: &TypedTransaction,
        _block: Option<BlockId>,
    ) -> Result<ethers::types::U256, Self::Error> {
        let params = self.parse_tx_params(tx);

        let estimate = self
            .rest
            .estimate_energy(&params.owner_hex, &params.contract_hex, &params.data_hex)
            .await
            .map_err(|e| ProviderError::CustomError(e.to_string()))?;

        match estimate.result.result {
            true => Ok(ethers::types::U256::from(estimate.energy_required)),
            false => {
                let message = format!(
                    "Energy estimation failed: code={}, message={}",
                    estimate.result.code.as_deref().unwrap_or("unknown"),
                    estimate.result.message.as_deref().unwrap_or("unknown"),
                );
                Err(ProviderError::CustomError(message))
            }
        }
    }
}

impl HyperlaneChain for TronProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for TronProvider {
    /// Get block info for a given block height
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let block = self.rest.get_block_by_num(height).await?;
        Self::get_block_info(&block)
    }

    /// Get txn info for a given txn hash
    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let txn = self
            .jsonrpc
            .get_transaction(*hash)
            .await
            .map_err(HyperlaneTronError::from)?
            .ok_or(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash))?;

        let receipt = self
            .jsonrpc
            .get_transaction_receipt(*hash)
            .await
            .map_err(HyperlaneTronError::from)?
            .map(|r| -> Result<_, HyperlaneProviderError> {
                Ok(TxnReceiptInfo {
                    gas_used: r.gas_used.ok_or(HyperlaneProviderError::NoGasUsed)?.into(),
                    cumulative_gas_used: r.cumulative_gas_used.into(),
                    effective_gas_price: r.effective_gas_price.map(Into::into),
                })
            })
            .transpose()?;

        let txn_info = TxnInfo {
            hash: *hash,
            max_fee_per_gas: txn.max_fee_per_gas.map(Into::into),
            max_priority_fee_per_gas: txn.max_priority_fee_per_gas.map(Into::into),
            gas_price: txn.gas_price.map(Into::into),
            gas_limit: txn.gas.into(),
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn.to.map(Into::into),
            receipt,
            raw_input_data: Some(txn.input.to_vec()),
        };

        Ok(txn_info)
    }

    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        let code = self
            .jsonrpc
            .get_code(ethers_core_types::H160::from(*address), None)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(!code.is_empty())
    }

    #[instrument(err, skip(self))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        // Can't use the address directly as a string, because ethers interprets it
        // as an ENS name rather than an address.
        let addr = hex_or_base58_or_bech32_to_h256(&address)?;
        let addr: Address = Address::from(addr);
        let balance = self
            .jsonrpc
            .get_balance(addr, None)
            .await
            .map_err(ChainCommunicationError::from_other)?;
        Ok(balance.into())
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let block = self.get_current_block().await?;
        let chain_metrics = ChainInfo::new(Self::get_block_info(&block)?, None);
        Ok(Some(chain_metrics))
    }
}
