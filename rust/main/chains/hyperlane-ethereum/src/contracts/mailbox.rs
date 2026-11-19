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
use futures_util::{future::join_all, FutureExt};
use hyperlane_core::Metadata;
use tokio::join;
use tokio::sync::Mutex;
use tracing::{instrument, warn};

use hyperlane_core::{
    rpc_clients::call_and_retry_indefinitely, BatchItem, BatchResult, ChainCommunicationError,
    ChainResult, ContractLocator, Decode, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneMessage, HyperlaneProvider, Indexed, Indexer, LogMeta, Mailbox,
    QueueOperation, RawHyperlaneMessage, ReorgPeriod, SequenceAwareIndexer, TxCostEstimate,
    TxOutcome, H160, H256, H512, U256,
};

use crate::error::HyperlaneEthereumError;
use crate::interfaces::arbitrum_node_interface::ArbitrumNodeInterface;
use crate::interfaces::i_mailbox::{IMailbox as EthereumMailboxInternal, IMAILBOX_ABI};
use crate::interfaces::mailbox::DispatchFilter;
use crate::tx::{
    call_with_reorg_period, cap_tx_gas_limit, estimate_eip1559_fees, estimate_tx_gas_limit,
    fill_tx_gas_params, latest_block, report_tx, Eip1559Fee,
};
use crate::{
    BuildableWithProvider, ConnectionConf, EthereumProvider, EthereumReorgPeriod,
    SignerRequirement, TransactionOverrides,
};

use super::multicall::{self, build_multicall, BatchCache};
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

    fn uses_dynamic_block_cache(&self) -> bool {
        true
    }

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

    fn uses_dynamic_block_cache(&self) -> bool {
        true
    }

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

/// Counts CCTP V2 MessageSent events from MessageTransmitter V2 in a transaction receipt.
///
/// MessageSent is emitted by MessageTransmitter V2 for both native USDC transfers
/// (depositForBurn → MessageTransmitter.sendMessage internally) and GMP messages
/// (sendMessage called directly). Supporting both lets the relay API handle the full
/// range of CCTP V2 usage patterns.
///
/// Both the topic hash and the emitting address are checked: topic-only matching would let
/// any contract spoof the V2 detection by emitting a log with the same topics[0]. Note that
/// MessageTransmitter V2's sendMessage is permissionless, so an attacker can produce a real
/// MessageSent from the canonical address with arbitrary body. The address check rules out
/// third-party contract spoofing but not direct transmitter calls; treat is_cctp_v2 as an
/// admission heuristic, not a verification claim.
fn cctp_v2_message_sent_count(logs: &[ethers::types::Log]) -> usize {
    use ethers::types::{Address, H256 as EthersH256};
    use ethers_core::utils::keccak256;

    let message_sent_topic = EthersH256::from(keccak256(b"MessageSent(bytes)"));

    // Circle deploys MessageTransmitter V2 at a small set of known addresses.
    // Source: https://developers.circle.com/cctp/references/contract-addresses#messagetransmitterv2
    let message_transmitter_v2_addresses: [Address; 3] = [
        "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" // mainnet (all chains except EDGE)
            .parse()
            .expect("valid address"),
        "0x5b61381Fc9e58E70EfC13a4A97516997019198ee" // mainnet EDGE
            .parse()
            .expect("valid address"),
        "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" // testnet (all chains)
            .parse()
            .expect("valid address"),
    ];

    logs.iter()
        .filter(|log| {
            message_transmitter_v2_addresses.contains(&log.address)
                && log.topics.first() == Some(&message_sent_topic)
        })
        .count()
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
    fn parse_tx_hash(&self, tx_hash: &str) -> ChainResult<H512> {
        hyperlane_core::parse_evm_hex_tx_hash(tx_hash)
    }

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
            .map(|(event, meta)| -> ChainResult<_> {
                Ok((
                    HyperlaneMessage::read_from(&mut event.message.as_ref())?.into(),
                    meta.into(),
                ))
            })
            .collect::<ChainResult<Vec<_>>>()?;

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
                fetch_raw_logs_and_meta::<DispatchFilter, M>(tx_hash, provider, contract)
                    .await?
                    .ok_or_else(|| {
                        ChainCommunicationError::CustomError(format!(
                            "No receipt found for tx hash {tx_hash:?}"
                        ))
                    })
            })
        })
        .await;
        let logs = raw_logs_and_meta
            .into_iter()
            .map(|(log, log_meta)| -> ChainResult<_> {
                Ok((
                    HyperlaneMessage::read_from(&mut log.message.as_ref())?.into(),
                    log_meta,
                ))
            })
            .collect::<ChainResult<Vec<_>>>()?;
        Ok(logs)
    }

    async fn fetch_logs_and_cctp_v2(
        &self,
        tx_hash: H512,
    ) -> ChainResult<(Vec<(Indexed<HyperlaneMessage>, LogMeta)>, bool)> {
        use ethers::abi::RawLog;
        use ethers::types::H256 as EthersH256;
        use ethers_contract::{EthEvent, LogMeta as EthersLogMeta};

        let (raw_dispatch_logs, is_cctp_v2) = call_and_retry_indefinitely(|| {
            let provider = self.provider.clone();
            let contract_address = self.contract.address();
            Box::pin(async move {
                let ethers_tx_hash: EthersH256 = tx_hash.into();
                let receipt = provider
                    .get_transaction_receipt(ethers_tx_hash)
                    .await
                    .map_err(ChainCommunicationError::from_other)?
                    .ok_or_else(|| {
                        ChainCommunicationError::CustomError(format!(
                            "No receipt found for tx hash {tx_hash:?}"
                        ))
                    })?;

                let message_sent_count = cctp_v2_message_sent_count(&receipt.logs);

                let dispatch_logs: Vec<(DispatchFilter, LogMeta)> = receipt
                    .logs
                    .into_iter()
                    .filter_map(|log| {
                        if log.address != contract_address {
                            return None;
                        }
                        let raw_log = RawLog {
                            topics: log.topics.clone(),
                            data: log.data.to_vec(),
                        };
                        let log_meta: EthersLogMeta = (&log).into();
                        DispatchFilter::decode_log(&raw_log)
                            .ok()
                            .map(|decoded| (decoded, log_meta.into()))
                    })
                    .collect();

                // Treat as CCTP V2 if every Dispatch has a corresponding MessageSent from
                // MessageTransmitter V2. Both native USDC transfers (depositForBurn path) and
                // GMP-only transfers (_postDispatch path) emit exactly 1 MessageSent per
                // Dispatch, so a 1:1 match is the correct invariant. A mixed tx (some CCTP,
                // some unrelated dispatches) produces fewer MessageSent than Dispatch events
                // and correctly gets is_cctp_v2=false.
                let is_cctp_v2 =
                    message_sent_count > 0 && message_sent_count == dispatch_logs.len();

                Ok((dispatch_logs, is_cctp_v2))
            })
        })
        .await;

        let messages = raw_dispatch_logs
            .into_iter()
            .map(|(log, meta)| -> ChainResult<_> {
                Ok((
                    HyperlaneMessage::read_from(&mut log.message.as_ref())?.into(),
                    meta,
                ))
            })
            .collect::<ChainResult<Vec<_>>>()?;

        Ok((messages, is_cctp_v2))
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

    async fn sequence_count_at_block(&self, block: u32) -> ChainResult<Option<u32>> {
        Ok(Some(
            self.contract.nonce().block(u64::from(block)).call().await?,
        ))
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

pub struct MailboxBuilder {
    pub protected_estimator: Option<Arc<dyn Mailbox>>,
}

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
        let mut mailbox = EthereumMailbox::new(Arc::new(provider), conn, locator);
        mailbox.protected_estimator = self.protected_estimator.clone();
        Box::new(mailbox)
    }
}

/// Read-only estimator with the relayer address, without signing middleware.
pub struct MailboxEstimateBuilder {}

#[async_trait]
impl BuildableWithProvider for MailboxEstimateBuilder {
    type Output = Arc<dyn Mailbox>;
    const NEEDS_SIGNER: bool = false;
    const SIGNER_REQUIREMENT: SignerRequirement = SignerRequirement::Sender;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Arc::new(EthereumMailbox::new(Arc::new(provider), conn, locator))
    }
}

/// A reference to a Mailbox contract on some Ethereum chain
pub struct EthereumMailbox<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMailboxInternal<M>>,
    domain: HyperlaneDomain,
    provider: Arc<M>,
    arbitrum_node_interface: Option<Arc<ArbitrumNodeInterface<M>>>,
    conn: ConnectionConf,
    protected_estimator: Option<Arc<dyn Mailbox>>,
    cache: Arc<Mutex<EthereumMailboxCache>>,
    batch_cache: Arc<Mutex<BatchCache>>,
}

impl<M: Middleware> std::fmt::Debug for EthereumMailbox<M> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EthereumMailbox")
            .field("domain", &self.domain)
            .field("address", &self.contract.address())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Default)]
pub struct EthereumMailboxCache {
    pub latest_block: Option<Block<TxHash>>,
    pub eip1559_fee: Option<Eip1559Fee>,
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
            protected_estimator: None,
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

    fn process_call_with_sender(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        tx_gas_estimate: Option<U256>,
    ) -> ChainResult<ContractCall<M, ()>> {
        let mut tx = self.contract_call(message, metadata, tx_gas_estimate)?;

        // Explicitly set `from` to the relayer's signer address so that during
        // eth_estimateGas the simulated msg.sender matches the trusted relayer.
        // TrustedRelayerIsm sets deliveries[id].processor = msg.sender *before*
        // calling ism.verify(), so verify() checks msg.sender == trustedRelayer.
        // Without this, from defaults to address(0) and estimation reverts.
        if let Some(sender) = self.provider.default_sender() {
            tx = tx.from(sender);
        }

        Ok(tx)
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

    #[instrument(skip(self, message, metadata))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
        tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        let contract_call = fill_tx_gas_params(
            self.process_call_with_sender(message, metadata, tx_gas_limit)?,
            self.provider.clone(),
            &self.conn.transaction_overrides,
            &self.domain,
            true,
            self.cache.clone(),
        )
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

    #[instrument(skip(self))]
    async fn process_estimate_costs(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
    ) -> ChainResult<TxCostEstimate> {
        if self
            .conn
            .mev_submission
            .as_ref()
            .is_some_and(|config| config.matches(message))
        {
            let estimator = self.protected_estimator.as_ref().ok_or_else(|| {
                ChainCommunicationError::CustomError("Missing protected mailbox estimator".into())
            })?;
            return tokio::time::timeout(
                std::time::Duration::from_secs(5),
                estimator.process_estimate_costs(message, metadata),
            )
            .await
            .map_err(|_| {
                ChainCommunicationError::CustomError("Protected mailbox estimate timed out".into())
            })?;
        }
        let call = self.process_call_with_sender(message, metadata, None)?;
        let block = async {
            let cached = self.cache.lock().await.latest_block.clone();
            match cached {
                Some(block) => Ok(block),
                None => latest_block(self.provider.clone()).await,
            }
        };
        // Return process() reverts before ancillary RPC errors. A failed
        // estimate or block lookup cancels the remaining gas reads.
        let gas_limit = async {
            let (estimate, block) =
                tokio::try_join!(biased; estimate_tx_gas_limit(&call), block.map(Ok))?;
            block.map(|block| cap_tx_gas_limit(estimate, &block))
        };

        let l2_gas_limit = async {
            let node = self.arbitrum_node_interface.as_ref()?;
            // A retryable ticket aliases msg.sender, which can make TrustedRelayerIsm
            // reject it. In that case use the direct process() estimate.
            let mut retryable_call = node.estimate_retryable_ticket(
                H160::zero().into(),
                // Give the sender a deposit (100 ETH), otherwise it reverts.
                WEI_IN_ETHER.mul(100u32),
                self.contract.address(),
                U256::zero().into(),
                H160::zero().into(),
                H160::zero().into(),
                call.calldata().unwrap_or_default(),
            );
            if let Some(&sender) = call.tx.from() {
                retryable_call = retryable_call.from(sender);
            }
            match retryable_call.estimate_gas().await {
                Ok(estimate) => Some(estimate.into()),
                Err(err) => {
                    warn!(?err, "Failed to estimate l2_gas_limit via ArbitrumNodeInterface, falling back to direct gas estimate");
                    None
                }
            }
        };
        let (gas_limit, l2_gas_limit, gas_price) = tokio::try_join!(
            biased;
            gas_limit,
            l2_gas_limit.map(Ok),
            self.provider.get_gas_price().map(Ok),
        )?;
        let gas_price: U256 = gas_price
            .map_err(ChainCommunicationError::from_other)?
            .into();
        Ok(TxCostEstimate {
            gas_limit,
            gas_price: gas_price.try_into()?,
            l2_gas_limit,
        })
    }

    async fn process_calldata(
        &self,
        message: &HyperlaneMessage,
        metadata: &Metadata,
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
    use std::{ops::Mul, sync::Arc};

    use ethers::{
        providers::{MockProvider, Provider},
        types::{Block, Transaction, U256 as EthersU256},
    };
    use hyperlane_core::{
        ContractLocator, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain, Mailbox,
        Metadata, TxCostEstimate, H160, H256, U256,
    };

    use crate::{
        contracts::EthereumMailbox, ConnectionConf, MevSubmissionConfig, RpcConnectionConf,
    };

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
                url: "http://127.0.0.1:8545".parse::<url::Url>().unwrap().into(),
            },
            transaction_overrides: Default::default(),
            op_submission_config: Default::default(),
            consider_null_transaction_receipt: false,
            fallback_hedge: None,
            mev_submission: None,
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

    fn push_estimate_responses(mock: &MockProvider, arbitrum: bool) {
        mock.push(U256::from(15)).unwrap();
        if arbitrum {
            mock.push(U256::from(200)).unwrap();
        }
        mock.push(Block::<Transaction> {
            gas_limit: EthersU256::MAX,
            ..Default::default()
        })
        .unwrap();
        mock.push(U256::from(1000)).unwrap();
    }

    #[tokio::test]
    async fn matching_reveal_estimates_never_use_ordinary_rpc() {
        for (domain, recipient) in [
            (KnownHyperlaneDomain::Ethereum, H256::zero()),
            (KnownHyperlaneDomain::Arbitrum, H256::zero()),
            (KnownHyperlaneDomain::Arbitrum, H256::from_low_u64_be(3)),
        ] {
            let domain = HyperlaneDomain::Known(domain);
            let (mut ordinary, ordinary_rpc) = get_test_mailbox(domain.clone());
            let (mut protected, protected_rpc) = get_test_mailbox(domain);
            ordinary.conn.transaction_overrides.gas_price = Some(1.into());
            protected.conn.transaction_overrides.gas_price = Some(1.into());
            protected.conn.rpc_connection = RpcConnectionConf::Http {
                url: "https://protected.example/private-key"
                    .parse::<url::Url>()
                    .unwrap()
                    .into(),
            };
            ordinary.conn.mev_submission = Some(MevSubmissionConfig {
                rpc_urls: vec!["https://protected.example/private-key".parse().unwrap()].into(),
                ica_router: H256::zero(),
                additional_ica_routers: vec![H256::from_low_u64_be(3)],
            });
            let arbitrum = protected.arbitrum_node_interface.is_some();
            ordinary.protected_estimator = Some(Arc::new(protected));
            assert!(!format!("{ordinary:?}").contains("private-key"));
            let message = HyperlaneMessage {
                recipient,
                body: vec![2; 65],
                ..Default::default()
            };
            let metadata = Metadata::new(vec![42; 32]);
            let expected_call = ordinary.contract_call(&message, &metadata, None).unwrap();

            push_estimate_responses(&protected_rpc, arbitrum);
            let estimate = ordinary
                .process_estimate_costs(&message, &metadata)
                .await
                .unwrap();
            assert_eq!(estimate.gas_limit, U256::from(1000));
            assert_eq!(estimate.l2_gas_limit, arbitrum.then(|| U256::from(200)));
            protected_rpc
                .assert_request("eth_estimateGas", [&expected_call.tx])
                .unwrap();
            protected_rpc
                .assert_request("eth_getBlockByNumber", ("latest", false))
                .unwrap();
            if let Some(node) = &ordinary.arbitrum_node_interface {
                let retryable = node.estimate_retryable_ticket(
                    H160::zero().into(),
                    ethers_core::utils::WEI_IN_ETHER.mul(100u32),
                    ordinary.contract.address(),
                    U256::zero().into(),
                    H160::zero().into(),
                    H160::zero().into(),
                    expected_call.calldata().unwrap(),
                );
                protected_rpc
                    .assert_request("eth_estimateGas", [&retryable.tx])
                    .unwrap();
            }
            protected_rpc.assert_request("eth_gasPrice", ()).unwrap();
            assert!(ordinary_rpc
                .assert_request("eth_estimateGas", [&expected_call.tx])
                .is_err());

            // Exhausted protected responses cause an error, never a public retry.
            assert!(ordinary
                .process_estimate_costs(&message, &metadata)
                .await
                .is_err());
            assert!(ordinary_rpc
                .assert_request("eth_estimateGas", [&expected_call.tx])
                .is_err());

            let commit = HyperlaneMessage {
                body: vec![1; 129],
                ..message
            };
            push_estimate_responses(&ordinary_rpc, arbitrum);
            assert!(ordinary
                .process_estimate_costs(&commit, &metadata)
                .await
                .is_ok());
            ordinary_rpc
                .assert_request(
                    "eth_estimateGas",
                    [&ordinary.contract_call(&commit, &metadata, None).unwrap().tx],
                )
                .unwrap();
        }
    }

    #[tokio::test]
    async fn process_estimate_costs_uses_arbitrum_retryable_gas_when_available() {
        for retryable_supported in [true, false] {
            let (mailbox, mock) =
                get_test_mailbox(HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum));
            let message = HyperlaneMessage::default();
            let metadata = Metadata::new(vec![]);
            let gas_price = U256::from(15_000_000_000u64);
            let gas_limit = U256::from(1_000_000u32);
            let retryable_gas_limit = U256::from(200_000u32);

            // Mock results are consumed in reverse push order.
            mock.push(gas_price).unwrap();
            if retryable_supported {
                mock.push(retryable_gas_limit).unwrap();
            } else {
                // This mock transport exposes response values only. A malformed
                // gas quantity returns a provider error from estimate_gas.
                mock.push::<&str, _>("not a gas quantity").unwrap();
            }
            mock.push(Block::<Transaction> {
                gas_limit: EthersU256::MAX,
                ..Default::default()
            })
            .unwrap();
            mock.push(gas_limit).unwrap();

            let estimate = mailbox
                .process_estimate_costs(&message, &metadata)
                .await
                .unwrap();
            assert_eq!(
                estimate,
                TxCostEstimate {
                    gas_limit,
                    gas_price: gas_price.try_into().unwrap(),
                    l2_gas_limit: retryable_supported.then_some(retryable_gas_limit),
                }
            );
            let call = mailbox.contract_call(&message, &metadata, None).unwrap();
            mock.assert_request("eth_estimateGas", [&call.tx]).unwrap();
            mock.assert_request("eth_getBlockByNumber", ("latest", false))
                .unwrap();
            let node = mailbox.arbitrum_node_interface.as_ref().unwrap();
            assert_eq!(node.address(), ethers::types::H160::from_low_u64_be(0xC8));
            let retryable = node.estimate_retryable_ticket(
                H160::zero().into(),
                ethers_core::utils::WEI_IN_ETHER.mul(100u32),
                mailbox.contract.address(),
                U256::zero().into(),
                H160::zero().into(),
                H160::zero().into(),
                call.calldata().unwrap(),
            );
            mock.assert_request("eth_estimateGas", [&retryable.tx])
                .unwrap();
            mock.assert_request("eth_gasPrice", ()).unwrap();
            assert!(mock.assert_request("eth_feeHistory", ()).is_err());
        }
    }

    #[tokio::test]
    async fn process_estimate_costs_uses_raw_sender_and_block_cap_without_submission_fees() {
        let (mut mailbox, mock) =
            get_test_mailbox(HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum));
        let sender = ethers::types::H160::from_low_u64_be(42);
        mailbox.provider = Arc::new(mailbox.provider.as_ref().clone().with_sender(sender));
        mailbox.conn.transaction_overrides.gas_limit = Some(U256::from(2_000_000u32));
        mailbox.conn.transaction_overrides.max_fee_per_gas = Some(U256::from(1));
        let message = HyperlaneMessage::default();
        let metadata = Metadata::new(vec![42; 32]);
        let expected_call = mailbox
            .contract_call(&message, &metadata, None)
            .unwrap()
            .from(sender);
        let gas_price = U256::from(15_000_000_000u64);
        let block_gas_limit = U256::from(1_012_345u32);
        mock.push(gas_price).unwrap();
        mock.push(Block::<Transaction> {
            gas_limit: block_gas_limit.into(),
            ..Default::default()
        })
        .unwrap();
        mock.push(U256::from(2_000_000u32)).unwrap();

        let estimate = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap();

        assert_eq!(
            estimate,
            TxCostEstimate {
                gas_limit: block_gas_limit,
                gas_price: gas_price.try_into().unwrap(),
                l2_gas_limit: None,
            }
        );
        mock.assert_request("eth_estimateGas", [&expected_call.tx])
            .unwrap();
        mock.assert_request("eth_getBlockByNumber", ("latest", false))
            .unwrap();
        mock.assert_request("eth_gasPrice", ()).unwrap();
        assert!(mock.assert_request("eth_feeHistory", ()).is_err());
    }

    #[tokio::test]
    async fn process_estimate_costs_returns_primary_estimate_errors() {
        let (mailbox, mock) =
            get_test_mailbox(HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum));
        let message = HyperlaneMessage::default();
        let metadata = Metadata::new(vec![]);
        let call = mailbox.contract_call(&message, &metadata, None).unwrap();
        // The primary request fails decoding. Ancillary requests would fail
        // with an empty response, but must never hide the contract error.
        mock.push::<&str, _>("not a gas quantity").unwrap();

        let error = mailbox
            .process_estimate_costs(&message, &metadata)
            .await
            .unwrap_err();

        assert!(matches!(
            error,
            hyperlane_core::ChainCommunicationError::ContractError(_)
        ));
        mock.assert_request("eth_estimateGas", [&call.tx]).unwrap();
        assert!(mock.assert_request("eth_getBlockByNumber", ()).is_err());
    }

    mod cctp_v2_message_sent_count {
        use ethers::types::{Bytes, Log, H160, H256 as EthersH256};
        use ethers_core::utils::keccak256;

        use super::super::cctp_v2_message_sent_count;

        fn message_sent_topic() -> EthersH256 {
            EthersH256::from(keccak256(b"MessageSent(bytes)"))
        }

        fn mainnet_transmitter() -> H160 {
            "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"
                .parse()
                .unwrap()
        }

        fn make_log(address: H160, topic: EthersH256) -> Log {
            Log {
                address,
                topics: vec![topic],
                data: Bytes::default(),
                ..Default::default()
            }
        }

        #[test]
        fn counts_message_sent_from_mainnet_transmitter() {
            let log = make_log(mainnet_transmitter(), message_sent_topic());
            assert_eq!(cctp_v2_message_sent_count(&[log]), 1);
        }

        #[test]
        fn counts_message_sent_from_edge_transmitter() {
            let edge: H160 = "0x5b61381Fc9e58E70EfC13a4A97516997019198ee"
                .parse()
                .unwrap();
            let log = make_log(edge, message_sent_topic());
            assert_eq!(cctp_v2_message_sent_count(&[log]), 1);
        }

        #[test]
        fn counts_message_sent_from_testnet_transmitter() {
            let testnet: H160 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"
                .parse()
                .unwrap();
            let log = make_log(testnet, message_sent_topic());
            assert_eq!(cctp_v2_message_sent_count(&[log]), 1);
        }

        #[test]
        fn ignores_message_sent_from_unknown_address() {
            let unknown: H160 = "0x1234567890123456789012345678901234567890"
                .parse()
                .unwrap();
            let log = make_log(unknown, message_sent_topic());
            assert_eq!(cctp_v2_message_sent_count(&[log]), 0);
        }

        #[test]
        fn ignores_wrong_topic_from_known_transmitter() {
            let wrong_topic = EthersH256::from(keccak256(b"SomeOtherEvent(bytes)"));
            let log = make_log(mainnet_transmitter(), wrong_topic);
            assert_eq!(cctp_v2_message_sent_count(&[log]), 0);
        }

        #[test]
        fn empty_logs_returns_zero() {
            assert_eq!(cctp_v2_message_sent_count(&[]), 0);
        }

        #[test]
        fn counts_multiple_message_sent_logs() {
            // Two matching logs should count as two
            let log = make_log(mainnet_transmitter(), message_sent_topic());
            assert_eq!(cctp_v2_message_sent_count(&[log.clone(), log]), 2);
        }
    }
}
