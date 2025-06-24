#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::ops::{Mul, RangeInclusive};
use std::sync::Arc;

use async_trait::async_trait;
use derive_new::new;
use ethers::prelude::Middleware;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers::types::{Block, H256 as TxHash};
use ethers_contract::builders::ContractCall;
use ethers_contract::{Multicall, MulticallResult};
use ethers_core::utils::WEI_IN_ETHER;
use futures_util::future::join_all;
use tokio::join;
use tokio::sync::Mutex;
use tracing::instrument;

use hyperlane_core::{
    rpc_clients::call_and_retry_indefinitely, utils::bytes_to_hex, BatchItem, BatchResult,
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain,
    HyperlaneContract, HyperlaneDomain, HyperlaneMessage, HyperlaneProtocolError,
    HyperlaneProvider, Indexed, Indexer, LogMeta, Mailbox, QueueOperation, RawHyperlaneMessage,
    ReorgPeriod, SequenceAwareIndexer, TxCostEstimate, TxOutcome, H160, H256, H512, U256,
};

use crate::error::HyperlaneEthereumError;
use crate::interfaces::arbitrum_node_interface::ArbitrumNodeInterface;
use crate::interfaces::i_mailbox::{IMailbox as EthereumMailboxInternal, IMAILBOX_ABI};
use crate::interfaces::mailbox::DispatchFilter;
use crate::tx::{
    call_with_reorg_period, estimate_eip1559_fees, fill_tx_gas_params, report_tx, Eip1559Fee,
};
use crate::{
    BuildableWithProvider, ConnectionConf, EthereumProvider, EthereumReorgPeriod,
    TransactionOverrides,
};

use super::multicall::{self, build_multicall};
use super::utils::{fetch_raw_logs_and_meta, get_finalized_block_number};

impl<M> std::fmt::Display for EthereumMailboxInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

pub struct SequenceIndexerBuilder {
    pub reorg_period: EthereumReorgPeriod,
}

#[async_trait]
impl BuildableWithProvider for SequenceIndexerBuilder {
    type Output = Box<dyn SequenceAwareIndexer<HyperlaneMessage>>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailboxIndexer::new(
            Arc::new(provider),
            locator,
            self.reorg_period,
        ))
    }
}

pub struct DeliveryIndexerBuilder {
    pub reorg_period: EthereumReorgPeriod,
}

#[async_trait]
impl BuildableWithProvider for DeliveryIndexerBuilder {
    type Output = Box<dyn SequenceAwareIndexer<H256>>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailboxIndexer::new(
            Arc::new(provider),
            locator,
            self.reorg_period,
        ))
    }
}

#[derive(Debug, Clone)]
/// Struct that retrieves event data for an Ethereum mailbox
pub struct EthereumMailboxIndexer<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    provider: Arc<M>,
    reorg_period: EthereumReorgPeriod,
}

impl<M> EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    /// Create new EthereumMailboxIndexer
    pub fn new(
        provider: Arc<M>,
        locator: &ContractLocator,
        reorg_period: EthereumReorgPeriod,
    ) -> Self {
        let contract = Arc::new(EthereumMailboxInternal::new(
            locator.address,
            provider.clone(),
        ));
        Self {
            contract,
            provider,
            reorg_period,
        }
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        get_finalized_block_number(&self.provider, &self.reorg_period).await
    }
}

#[async_trait]
impl<M> Indexer<HyperlaneMessage> for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }

    /// Note: This call may return duplicates depending on the provider used
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let mut events: Vec<(Indexed<HyperlaneMessage>, LogMeta)> = self
            .contract
            .dispatch_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| {
                (
                    HyperlaneMessage::from(event.message.to_vec()).into(),
                    meta.into(),
                )
            })
            .collect();

        events.sort_by(|a, b| a.0.inner().nonce.cmp(&b.0.inner().nonce));
        Ok(events)
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
        let raw_logs_and_meta = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract = self.contract.address();
            Box::pin(async move {
                fetch_raw_logs_and_meta::<DispatchFilter, M>(tx_hash, provider, contract).await
            })
        })
        .await;
        let logs = raw_logs_and_meta
            .into_iter()
            .map(|(log, log_meta)| {
                (
                    HyperlaneMessage::from(log.message.to_vec()).into(),
                    log_meta,
                )
            })
            .collect();
        Ok(logs)
    }
}

#[async_trait]
impl<M> SequenceAwareIndexer<HyperlaneMessage> for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self).await?;
        let sequence = self.contract.nonce().block(u64::from(tip)).call().await?;
        Ok((Some(sequence), tip))
    }
}

#[async_trait]
impl<M> Indexer<H256> for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }

    /// Note: This call may return duplicates depending on the provider used
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<H256>, LogMeta)>> {
        Ok(self
            .contract
            .process_id_filter()
            .from_block(*range.start())
            .to_block(*range.end())
            .query_with_meta()
            .await?
            .into_iter()
            .map(|(event, meta)| (Indexed::new(H256::from(event.message_id)), meta.into()))
            .collect())
    }
}

#[async_trait]
impl<M> SequenceAwareIndexer<H256> for EthereumMailboxIndexer<M>
where
    M: Middleware + 'static,
{
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        // A blanket implementation for this trait is fine for the EVM.
        // TODO: Consider removing `Indexer` as a supertrait of `SequenceAwareIndexer`
        let tip = Indexer::<H256>::get_finalized_block_number(self).await?;
        Ok((None, tip))
    }
}

pub struct MailboxBuilder {}

#[async_trait]
impl BuildableWithProvider for MailboxBuilder {
    type Output = Box<dyn Mailbox>;
    const NEEDS_SIGNER: bool = true;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMailbox::new(Arc::new(provider), conn, locator))
    }
}

/// A reference to a Mailbox contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMailbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
    arbitrum_node_interface: Option<Arc<ArbitrumNodeInterface<M>>>,
    conn: ConnectionConf,
    cache: Arc<Mutex<EthereumMailboxCache>>,
    batch_cache: Arc<Mutex<BatchCache>>,
}

#[derive(Debug, Default)]
pub struct EthereumMailboxCache {
    pub latest_block: Option<Block<TxHash>>,
    pub eip1559_fee: Option<Eip1559Fee>,
}

#[derive(Debug, Default)]
pub struct BatchCache {
    pub is_contract: HashMap<H256, bool>,
}

impl<M> EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, conn: &ConnectionConf, locator: &ContractLocator) -> Self {
        // Arbitrum Nitro based chains are a special case for transaction cost estimation.
        // The gas amount that eth_estimateGas returns considers both L1 and L2 gas costs.
        // We use the NodeInterface, found at address(0xC8), to isolate the L2 gas costs.
        // See https://developer.arbitrum.io/arbos/gas#nodeinterfacesol or https://github.com/OffchainLabs/nitro/blob/master/contracts/src/node-interface/NodeInterface.sol#L25
        let arbitrum_node_interface = locator.domain.is_arbitrum_nitro().then(|| {
            Arc::new(ArbitrumNodeInterface::new(
                H160::from_low_u64_be(0xC8),
                provider.clone(),
            ))
        });

        Self {
            contract: Arc::new(EthereumMailboxInternal::new(
                locator.address,
                provider.clone(),
            )),
            domain: locator.domain.clone(),
            provider,
            arbitrum_node_interface,
            conn: conn.clone(),
            cache: Default::default(),
            batch_cache: Default::default(),
        }
    }

    fn contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_estimate: Option<U256>,
    ) -> ChainResult<ContractCall<M, ()>> {
        let mut tx = self.contract.process(
            metadata.to_vec().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        if let Some(gas_estimate) = tx_gas_estimate {
            tx = tx.gas(gas_estimate);
        }
        Ok(tx)
    }

    /// Returns a ContractCall that processes the provided message.
    async fn process_contract_call(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_estimate: Option<U256>,
        with_gas_estimate_buffer: bool,
    ) -> ChainResult<ContractCall<M, ()>> {
        let tx = self.contract_call(message, metadata, tx_gas_estimate)?;

        fill_tx_gas_params(
            tx,
            self.provider.clone(),
            &self.conn.transaction_overrides.clone(),
            &self.domain,
            with_gas_estimate_buffer,
            self.cache.clone(),
        )
        .await
    }

    async fn simulate_batch(
        &self,
        multicall: &mut Multicall<M>,
        contract_calls: Vec<ContractCall<M, ()>>,
    ) -> ChainResult<BatchSimulation<M>> {
        let batch = multicall::batch::<_, ()>(multicall, contract_calls.clone());
        let call_results = batch.call().await?;

        let (successful, failed) = multicall::filter_failed(contract_calls, call_results);

        if successful.is_empty() {
            return Ok(BatchSimulation::failed(failed.len()));
        }

        let successful_batch = multicall::batch::<_, ()>(multicall, successful.clone());

        Ok(BatchSimulation::new(
            Some(self.submittable_batch(successful_batch)),
            successful,
            failed,
        ))
    }

    fn submittable_batch(
        &self,
        call: ContractCall<M, Vec<MulticallResult>>,
    ) -> SubmittableBatch<M> {
        SubmittableBatch {
            call,
            provider: self.provider.clone(),
            transaction_overrides: self.conn.transaction_overrides.clone(),
            domain: self.domain.clone(),
        }
    }

    async fn _submit_multicall(
        &self,
        multicall: &mut Multicall<M>,
        contract_calls: Vec<ContractCall<M, ()>>,
        cache: Arc<Mutex<EthereumMailboxCache>>,
    ) -> ChainResult<BatchResult> {
        let batch = multicall::batch::<_, ()>(multicall, contract_calls.clone());
        let call_with_gas_overrides = fill_tx_gas_params(
            batch,
            self.provider.clone(),
            &self.conn.transaction_overrides.clone(),
            &self.domain,
            true,
            cache,
        )
        .await?;
        let outcome = report_tx(call_with_gas_overrides).await?;
        Ok(BatchResult::new(Some(outcome.into()), vec![]))
    }

    async fn _simulate_and_submit_batch(
        &self,
        multicall: &mut Multicall<M>,
        contract_calls: Vec<ContractCall<M, ()>>,
        cache: Arc<Mutex<EthereumMailboxCache>>,
    ) -> ChainResult<BatchResult> {
        let batch_simulation = self.simulate_batch(multicall, contract_calls).await?;
        batch_simulation.try_submit(cache).await
    }

    async fn refresh_block_and_fee_cache(&self, tx: &TypedTransaction) {
        let Some((eip1559_fee, latest_block)) =
            estimate_eip1559_fees(self.provider.clone(), None, &self.domain, tx)
                .await
                .ok()
        else {
            return;
        };
        let mut cache = self.cache.lock().await;
        cache.latest_block = Some(latest_block);
        cache.eip1559_fee = Some(eip1559_fee);
    }
}

#[derive(new)]
pub struct BatchSimulation<M> {
    pub call: Option<SubmittableBatch<M>>,
    /// Successful individual calls
    pub successful: Vec<ContractCall<M, ()>>,
    /// Indexes of excluded calls in the batch (because they either failed the simulation
    /// or they were the only successful call)
    pub excluded_call_indexes: Vec<usize>,
}

impl<M> BatchSimulation<M> {
    pub fn failed(ops_count: usize) -> Self {
        Self::new(None, vec![], (0..ops_count).collect())
    }
}

impl<M: Middleware + 'static> BatchSimulation<M> {
    pub async fn try_submit(
        self,
        cache: Arc<Mutex<EthereumMailboxCache>>,
    ) -> ChainResult<BatchResult> {
        if let Some(mut submittable_batch) = self.call {
            let gas_limit = multicall::estimate(&submittable_batch.call, self.successful).await?;
            submittable_batch.call.tx.set_gas(gas_limit);
            let batch_outcome = submittable_batch.submit(cache).await?;
            Ok(BatchResult::new(
                Some(batch_outcome),
                self.excluded_call_indexes,
            ))
        } else {
            Ok(BatchResult::failed(self.excluded_call_indexes.len()))
        }
    }
}

pub struct SubmittableBatch<M> {
    pub call: ContractCall<M, Vec<MulticallResult>>,
    provider: Arc<M>,
    transaction_overrides: TransactionOverrides,
    domain: HyperlaneDomain,
}

impl<M: Middleware + 'static> SubmittableBatch<M> {
    pub async fn submit(self, cache: Arc<Mutex<EthereumMailboxCache>>) -> ChainResult<TxOutcome> {
        let call_with_gas_overrides = fill_tx_gas_params(
            self.call,
            self.provider,
            &self.transaction_overrides,
            &self.domain,
            true,
            cache,
        )
        .await?;
        let outcome = report_tx(call_with_gas_overrides).await?;
        Ok(outcome.into())
    }
}

impl<M> HyperlaneChain for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.provider.clone(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> Mailbox for EthereumMailbox<M>
where
    M: Middleware + 'static,
{
    #[instrument(skip(self))]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        let call =
            call_with_reorg_period(self.contract.nonce(), &self.provider, reorg_period).await?;
        let nonce = call.call().await?;
        Ok(nonce)
    }

    #[instrument(skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        Ok(self.contract.delivered(id.into()).call().await?)
    }

    #[instrument(skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        Ok(self.contract.default_ism().call().await?.into())
    }

    #[instrument(skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        Ok(self
            .contract
            .recipient_ism(recipient.into())
            .call()
            .await?
            .into())
    }

    #[instrument(skip(self, message, metadata), fields(metadata=%bytes_to_hex(metadata)))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = self
            .process_contract_call(message, metadata, tx_gas_limit, true)
            .await?;
        let receipt = report_tx(contract_call).await?;
        Ok(receipt.into())
    }

    /// Returns true if the mailbox supports batching
    fn supports_batching(&self) -> bool {
        true
    }

    #[instrument(skip(self, ops), fields(size=%ops.len()))]
    async fn process_batch<'a>(&self, ops: Vec<&'a QueueOperation>) -> ChainResult<BatchResult> {
        let messages = ops
            .iter()
            .map(|op| op.try_batch())
            .collect::<ChainResult<Vec<BatchItem<HyperlaneMessage>>>>()?;

        let mut multicall = build_multicall(
            self.provider.clone(),
            self.domain.clone(),
            self.batch_cache.clone(),
            self.conn.batch_contract_address(),
        )
        .await
        .map_err(|e| HyperlaneEthereumError::MulticallError(e.to_string()))?;

        let contract_calls = messages
            .iter()
            .map(|batch_item| {
                self.contract_call(
                    &batch_item.data,
                    &batch_item.submission_data.metadata,
                    Some(batch_item.submission_data.gas_limit),
                )
            })
            .collect::<ChainResult<Vec<_>>>()?;

        let simulate_future = self.simulate_batch(&mut multicall, contract_calls.clone());
        let refresh_cache_future = async {
            if let Some(contract_call) = contract_calls.first() {
                self.refresh_block_and_fee_cache(&contract_call.tx).await
            }
        };

        let (simulate_result, _) = join!(simulate_future, refresh_cache_future);
        let mut simulation = simulate_result?;

        let filled_tx_params_futures = simulation.successful.iter().map(|tx| {
            fill_tx_gas_params(
                tx.clone(),
                self.provider.clone(),
                &self.conn.transaction_overrides,
                &self.domain,
                false,
                self.cache.clone(),
            )
        });
        let contract_calls = join_all(filled_tx_params_futures)
            .await
            .into_iter()
            .collect::<ChainResult<Vec<_>>>()?;

        simulation.successful = contract_calls;

        simulation.try_submit(self.cache.clone()).await
    }

    #[instrument(skip(self), fields(msg=%message, metadata=%bytes_to_hex(metadata)))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        // this function is used to get an accurate gas estimate for the transaction
        // rather than a gas amount that will guarantee inclusion, so we use `false`
        // for the `with_gas_estimate_buffer` arg in `process_contract_call`
        let contract_call = self
            .process_contract_call(message, metadata, None, false)
            .await?;
        let gas_limit = contract_call
            .tx
            .gas()
            .copied()
            .ok_or(HyperlaneProtocolError::ProcessGasLimitRequired)?;

        // If we have a ArbitrumNodeInterface, we need to set the l2_gas_limit.
        let l2_gas_limit = if let Some(arbitrum_node_interface) = &self.arbitrum_node_interface {
            Some(
                arbitrum_node_interface
                    .estimate_retryable_ticket(
                        H160::zero().into(),
                        // Give the sender a deposit (100 ETH), otherwise it reverts
                        WEI_IN_ETHER.mul(100u32),
                        self.contract.address(),
                        U256::zero().into(),
                        H160::zero().into(),
                        H160::zero().into(),
                        contract_call.calldata().unwrap_or_default(),
                    )
                    .estimate_gas()
                    .await?,
            )
        } else {
            None
        };

        let gas_price: U256 = self
            .provider
            .get_gas_price()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into();

        Ok(TxCostEstimate {
            gas_limit: gas_limit.into(),
            gas_price: gas_price.try_into()?,
            l2_gas_limit: l2_gas_limit.map(|v| v.into()),
        })
    }

    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
    ) -> ChainResult<Vec<u8>> {
        let mut contract_call = self.contract.process(
            metadata.to_vec().into(),
            RawHyperlaneMessage::from(message).to_vec().into(),
        );
        contract_call.tx.set_chain_id(self.domain.id());
        let data = (contract_call.tx, contract_call.function);
        serde_json::to_vec(&data).map_err(Into::into)
    }

    fn delivered_calldata(&self, message_id: H256) -> ChainResult<Option<Vec<u8>>> {
        let call = self.contract.delivered(message_id.into());

        let data = (call.tx, call.function);
        serde_json::to_vec(&data).map(Some).map_err(Into::into)
    }
}

pub struct EthereumMailboxAbi;

impl HyperlaneAbi for EthereumMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IMAILBOX_ABI)
    }
}

#[cfg(test)]
mod test {
    use std::{str::FromStr, sync::Arc};

    use ethers::{
        providers::{MockProvider, Provider},
        types::{Block, Transaction, U256 as EthersU256},
    };
    use ethers_core::types::FeeHistory;
    use hyperlane_core::{
        ContractLocator, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox,
        TxCostEstimate, H160, H256, U256,
    };

    use crate::{contracts::EthereumMailbox, ConnectionConf, RpcConnectionConf};

    fn get_test_mailbox(
        domain: HyperlaneDomain,
    ) -> (
        EthereumMailbox<Provider<Arc<MockProvider>>>,
        Arc<MockProvider>,
    ) {
        let mock_provider = Arc::new(MockProvider::new());
        let provider = Arc::new(Provider::new(mock_provider.clone()));
        let connection_conf = ConnectionConf {
            rpc_connection: RpcConnectionConf::Http {
                url: "http://127.0.0.1:8545".parse().unwrap(),
            },
            transaction_overrides: Default::default(),
            op_submission_config: Default::default(),
        };

        let mailbox = EthereumMailbox::new(
            provider.clone(),
            &connection_conf,
            &ContractLocator {
                domain: &domain,
                // Address doesn't matter because we're using a MockProvider
                address: H256::default(),
            },
        );
        (mailbox, mock_provider)
    }

    #[tokio::test]
    async fn test_process_estimate_costs_sets_l2_gas_limit_for_arbitrum() {
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::PlumeTestnet);
        // An Arbitrum Nitro chain
        let (mailbox, mock_provider) = get_test_mailbox(domain.clone());

        let message = HyperlaneMessage::default();
        let metadata: Vec<u8> = vec![];

        assert!(mailbox.arbitrum_node_interface.is_some());
        // Confirm `H160::from_low_u64_ne(0xC8)` does what's expected
        assert_eq!(
            H160::from(mailbox.arbitrum_node_interface.as_ref().unwrap().address()),
            H160::from_str("0x00000000000000000000000000000000000000C8").unwrap(),
        );

        // The MockProvider responses we push are processed in LIFO
        // order, so we start with the final RPCs and work toward the first
        // RPCs

        // RPC 4: eth_gasPrice by process_estimate_costs
        // Return 15 gwei
        let gas_price: U256 =
            EthersU256::from(ethers::utils::parse_units("15", "gwei").unwrap()).into();
        mock_provider.push(gas_price).unwrap();

        // RPC 6: eth_estimateGas to the ArbitrumNodeInterface's estimateRetryableTicket function by process_estimate_costs
        let l2_gas_limit = U256::from(200000); // 200k gas
        mock_provider.push(l2_gas_limit).unwrap();

        let fee_history = FeeHistory {
            oldest_block: ethers::types::U256::zero(),
            base_fee_per_gas: vec![],
            gas_used_ratio: vec![],
            reward: vec![vec![]],
        };

        // RPC 5: eth_feeHistory from the estimate_eip1559_fees_default
        mock_provider.push(fee_history).unwrap();

        let latest_block: Block<Transaction> = Block {
            gas_limit: ethers::types::U256::MAX,
            ..Block::<Transaction>::default()
        };

        // RPC 4: eth_getBlockByNumber from the estimate_eip1559_fees_default
        mock_provider.push(latest_block.clone()).unwrap();

        // RPC 3: eth_getBlockByNumber from the fill_tx_gas_params call in process_contract_call
        // to get the latest block gas limit and for eip 1559 fee estimation
        mock_provider.push(latest_block).unwrap();

        // RPC 1: eth_estimateGas from the estimate_gas call in process_contract_call
        // Return 1M gas
        let gas_limit = U256::from(1000000u32);
        mock_provider.push(gas_limit).unwrap();

        let tx_cost_estimate = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap();

        assert_eq!(
            tx_cost_estimate,
            TxCostEstimate {
                gas_limit,
                gas_price: gas_price.try_into().unwrap(),
                l2_gas_limit: Some(l2_gas_limit),
            },
        );
    }

    #[tokio::test]
    async fn test_tx_gas_limit_caps_at_block_gas_limit() {
        let (mailbox, mock_provider) =
            get_test_mailbox(HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum));

        let message = HyperlaneMessage::default();
        let metadata: Vec<u8> = vec![];

        // The MockProvider responses we push are processed in LIFO
        // order, so we start with the final RPCs and work toward the first
        // RPCs

        // RPC 6: eth_gasPrice by process_estimate_costs
        // Return 15 gwei
        let gas_price: U256 =
            EthersU256::from(ethers::utils::parse_units("15", "gwei").unwrap()).into();
        mock_provider.push(gas_price).unwrap();

        let fee_history = FeeHistory {
            oldest_block: ethers::types::U256::zero(),
            base_fee_per_gas: vec![],
            gas_used_ratio: vec![],
            reward: vec![vec![]],
        };

        // RPC 5: eth_feeHistory from the estimate_eip1559_fees_default
        mock_provider.push(fee_history).unwrap();

        let latest_block_gas_limit = U256::from(12345u32);
        let latest_block: Block<Transaction> = Block {
            gas_limit: latest_block_gas_limit.into(),
            ..Block::<Transaction>::default()
        };

        // RPC 4: eth_getBlockByNumber from the estimate_eip1559_fees_default
        mock_provider.push(latest_block.clone()).unwrap();

        // RPC 3: eth_getBlockByNumber from the fill_tx_gas_params call in process_contract_call
        // to get the latest block gas limit and for eip 1559 fee estimation
        mock_provider.push(latest_block).unwrap();

        // RPC 1: eth_estimateGas from the estimate_gas call in process_contract_call
        // Return 1M gas
        let gas_limit = U256::from(1000000u32);
        mock_provider.push(gas_limit).unwrap();

        let tx_cost_estimate = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap();

        assert_eq!(
            tx_cost_estimate,
            TxCostEstimate {
                // The block gas limit is the cap
                gas_limit: latest_block_gas_limit,
                gas_price: gas_price.try_into().unwrap(),
                l2_gas_limit: None,
            },
        );
    }
}
