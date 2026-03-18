use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::abi::Address;
use ethers::contract::builders::ContractCall;
use ethers::providers::Provider;
use ethers::providers::{Middleware, ProviderError};
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{BlockId, Bytes, H160};
use hyperlane_core::utils::hex_or_base58_or_bech32_to_h256;
use num::ToPrimitive;
use prost::Message;
use prost_types::Any;
use time::OffsetDateTime;
use tracing::{debug, instrument};
use tron_rs::tron::protocol::{
    transaction::{self, contract::ContractType, Contract},
    Transaction, TriggerSmartContract,
};

use hyperlane_core::{
    ethers_core_types, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, ContractLocator,
    HyperlaneChain, HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, TxOutcome, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::{self, PrometheusClientMetrics};

use super::types::{BlockResponse, TriggerContractRequest};
use crate::{
    build_fallback_provider, calculate_ref_block_bytes, calculate_ref_block_hash, calculate_txid,
    ConnectionConf, HyperlaneTronError, JsonProvider, TronHttpProvider, TronSigner,
    DEFAULT_ENERGY_MULTIPLIER,
};

/// Tron Provider
#[derive(Clone, Debug)]
pub struct TronProvider {
    wallet: TronHttpProvider,
    wallet_solidity: TronHttpProvider,
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
        let wallet = TronHttpProvider::new(
            vec![conf.wallet_url.clone()],
            metrics.clone(),
            chain.clone(),
        )?;
        let wallet_solidity = TronHttpProvider::new(
            vec![conf.wallet_solidity_url.clone()],
            metrics.clone(),
            chain.clone(),
        )?;
        let jsonrpc = build_fallback_provider(&conf.rpc_urls, metrics, chain)?;

        Ok(Self {
            wallet,
            wallet_solidity,
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

    fn build_tx(
        trigger: &TriggerSmartContract,
        block: &BlockResponse,
        fee_limit: u64,
    ) -> ChainResult<(Transaction, H256)> {
        let call = Any::from_msg(trigger).map_err(HyperlaneTronError::from)?;

        let contract = Contract {
            r#type: ContractType::TriggerSmartContract.into(),
            parameter: Some(call),
            provider: vec![],
            contract_name: vec![],
            permission_id: 0,
        };

        let block_id_bytes =
            hex::decode(&block.block_id).map_err(|_| HyperlaneTronError::MissingRawData)?;
        let ref_block_bytes = calculate_ref_block_bytes(block.block_header.raw_data.number);
        let ref_block_hash = calculate_ref_block_hash(&block_id_bytes);

        let raw_data = transaction::Raw {
            ref_block_bytes: ref_block_bytes.clone(),
            ref_block_num: block.block_header.raw_data.number,
            ref_block_hash: ref_block_hash.clone(),
            timestamp: OffsetDateTime::now_utc()
                .unix_timestamp()
                .checked_mul(1000)
                .unwrap_or_default(),
            expiration: OffsetDateTime::now_utc()
                .unix_timestamp()
                .saturating_add(60)
                .checked_mul(1000)
                .unwrap_or_default(),
            auths: vec![],
            data: vec![],
            contract: vec![contract.clone()],
            scripts: vec![],
            fee_limit: fee_limit as i64,
        };

        let hash = calculate_txid(&raw_data);

        Ok((
            Transaction {
                raw_data: Some(raw_data),
                signature: vec![],
                ret: vec![],
            },
            hash,
        ))
    }

    fn parse_tx(&self, tx: &TypedTransaction) -> TriggerContractRequest {
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
        const ADDRESS_PREFIX: u8 = 0x41;
        TriggerContractRequest {
            owner_address: hex::encode([&[ADDRESS_PREFIX], owner.as_bytes()].concat()),
            contract_address: hex::encode([&[ADDRESS_PREFIX], to.as_bytes()].concat()),
            data: hex::encode(data.to_vec()),
            call_value: value.as_u64() as i64,
            visible: false,
        }
    }

    /// Build a TriggerSmartContract protobuf from a TriggerContractRequest (for tx construction)
    fn trigger_contract_request_to_proto(req: &TriggerContractRequest) -> TriggerSmartContract {
        TriggerSmartContract {
            owner_address: hex::decode(&req.owner_address).unwrap_or_default(),
            contract_address: hex::decode(&req.contract_address).unwrap_or_default(),
            call_value: req.call_value,
            data: hex::decode(&req.data).unwrap_or_default(),
            call_token_value: 0,
            token_id: 0,
        }
    }

    /// Get the current block
    async fn get_current_block(&self) -> ChainResult<BlockResponse> {
        self.wallet_solidity.get_now_block().await
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

        let block = self.get_current_block().await?;
        let tron_call = self.parse_tx(tx);
        let proto_call = Self::trigger_contract_request_to_proto(&tron_call);
        let (mut tx, hash) = Self::build_tx(&proto_call, &block, fee_limit)?;

        let signer = self.get_signer()?;
        let signature = signer
            .sign_hash(hash)
            .await
            .map_err(HyperlaneTronError::from)?;

        // Set the signature
        tx.signature = vec![signature.to_vec()];

        self.broadcast_transaction(tx).await?;

        Ok(hash)
    }

    /// Broadcast transaction
    pub async fn broadcast_transaction(&self, tx: Transaction) -> ChainResult<()> {
        let tx_bytes = tx.encode_to_vec();
        let hex_tx = hex::encode(&tx_bytes);
        let result = self.wallet.broadcast_hex(hex_tx).await?;

        match result.result {
            Some(true) => Ok(()),
            _ => {
                // Tron HTTP API returns hex-encoded error messages
                let decoded_msg = result
                    .message
                    .as_deref()
                    .and_then(|m| hex::decode(m).ok())
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .unwrap_or_else(|| result.message.clone().unwrap_or_else(|| "unknown".into()));
                let message = format!(
                    "Failed to broadcast transaction: code={:?}, message={}",
                    result.code, decoded_msg
                );
                Err(HyperlaneTronError::BroadcastTransactionError(message).into())
            }
        }
    }

    fn get_block_info(block: &BlockResponse) -> BlockInfo {
        BlockInfo {
            hash: H256::from_slice(&hex::decode(&block.block_id).unwrap_or_else(|_| vec![0u8; 32])),
            timestamp: block
                .block_header
                .raw_data
                .timestamp
                .checked_div(1000)
                .unwrap_or_default() as u64,
            number: block.block_header.raw_data.number as u64,
        }
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
        let tron_call = self.parse_tx(tx);

        let call = self
            .wallet_solidity
            .trigger_constant_contract(tron_call)
            .await
            .map_err(|e| ProviderError::CustomError(e.to_string()))?;

        let data = call
            .constant_result
            .first()
            .ok_or_else(|| {
                ProviderError::CustomError(
                    "No constant result returned from trigger_constant_contract".into(),
                )
            })?
            .clone();

        Ok(Bytes::from(hex::decode(&data).map_err(|e| {
            ProviderError::CustomError(format!("Failed to decode hex constant_result: {e}"))
        })?))
    }

    async fn estimate_gas(
        &self,
        tx: &TypedTransaction,
        _block: Option<BlockId>,
    ) -> Result<ethers::types::U256, Self::Error> {
        let call = self.parse_tx(tx);

        let estimate = self
            .wallet
            .estimate_energy(call)
            .await
            .map_err(|e| ProviderError::CustomError(e.to_string()))?;

        Ok(ethers::types::U256::from(estimate.energy_required as u64))
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
        let block = self.wallet_solidity.get_block_by_num(height as i64).await?;
        Ok(Self::get_block_info(&block))
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
        let chain_metrics = ChainInfo::new(Self::get_block_info(&block), None);
        Ok(Some(chain_metrics))
    }
}
