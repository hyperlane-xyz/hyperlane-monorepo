use std::collections::{BTreeMap, HashMap, HashSet};

use async_trait::async_trait;
use ethers::{
    abi::RawLog,
    contract::EthEvent,
    providers::Middleware,
    types::{
        BlockId, BlockNumber, Filter, Log, TransactionRequest, H160, H256 as EthersH256, U256,
    },
};
use eyre::{ensure, eyre, Result};
use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::{
    ContractLocator, Decode, HyperlaneDomainProtocol, HyperlaneMessage, HyperlaneProvider,
    IndexMode, Indexed, InterchainGasPayment, LogMeta, MerkleTreeInsertion, SequenceAwareIndexer,
    H256, H512,
};
use hyperlane_ethereum::{
    event_filters::{DispatchFilter, GasPaymentFilter, InsertedIntoTreeFilter, ProcessIdFilter},
    BuildableWithProvider, ConnectionConf,
};
use tokio::sync::RwLock;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Header {
    pub height: u64,
    pub timestamp: u64,
    pub hash: EthersH256,
    /// Zero when the protocol provider does not expose parent hashes.
    pub parent: EthersH256,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Event {
    pub block_number: u64,
    pub block_hash: EthersH256,
    pub address: H256,
    pub tx_hash: Option<H512>,
    pub tx_index: u64,
    pub log_index: u64,
    pub sequence: Option<u32>,
    pub data: EventData,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum EventData {
    Dispatch(HyperlaneMessage),
    Delivery(H256),
    Insertion {
        message_id: H256,
        index: u32,
    },
    Gas {
        message_id: H256,
        destination: u32,
        gas: String,
        payment: String,
    },
}

pub(super) struct EventBatch {
    pub events: Vec<Event>,
    pub indexed_through: Option<u64>,
    /// Stream counts at `indexed_through`, when the indexer can prove them at
    /// that exact boundary. Block-mode ingestion uses these to reject a
    /// silently truncated range.
    pub end_counts: [Option<u32>; 4],
    /// Streams whose indexers expose sequence counts. A missing end count for
    /// one of these streams makes this boundary unsafe to publish.
    pub count_capable: [bool; 4],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Contracts {
    pub mailbox: H256,
    pub hook: H256,
    pub paymaster: H256,
}

#[derive(Clone, Copy, Debug)]
pub(super) enum BlockSelector {
    Height(u64),
    Latest,
    Safe,
    Finalized,
}

impl From<u64> for BlockSelector {
    fn from(height: u64) -> Self {
        Self::Height(height)
    }
}

#[async_trait]
pub(super) trait Source: Send + Sync {
    async fn begin_cycle(&self) {}
    async fn header(&self, block: BlockSelector) -> Result<Header>;
    async fn fresh_header(&self, block: BlockSelector) -> Result<Header> {
        self.header(block).await
    }
    async fn range_end(&self, after: u64, through: u64, _head: u64) -> Result<Header> {
        ensure!(after < through, "Empty indexing range");
        self.header(BlockSelector::Height(through)).await
    }
    async fn fresh_range_end(&self, after: u64, through: u64, head: u64) -> Result<Header> {
        self.range_end(after, through, head).await
    }
    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>>;
    async fn events_after(
        &self,
        from: u64,
        through: u64,
        _sequences: [u32; 4],
    ) -> Result<EventBatch> {
        Ok(EventBatch {
            events: self.events(from, through).await?,
            indexed_through: None,
            end_counts: [None; 4],
            count_capable: [false; 4],
        })
    }
    /// Dispatch nonce and Merkle count, pinned to the range boundary fork.
    async fn counts(&self, hash: EthersH256) -> Result<[u32; 2]>;
    fn has_historical_counts(&self) -> bool {
        true
    }
    fn indexes_by_sequence(&self) -> bool {
        false
    }
    /// Whether a successful block-range query proves it scanned through the
    /// requested boundary without relying on a boundary sequence count.
    fn block_ranges_are_complete(&self) -> bool {
        false
    }
    /// Highest block for which every event stream can return a complete range.
    async fn indexing_tip(&self) -> Result<Option<u64>> {
        Ok(None)
    }
    async fn empty_anchor(&self) -> Result<Option<Header>> {
        Ok(None)
    }
}

pub(super) struct SourceBuilder {
    pub contracts: EvmContracts,
    pub domain: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EvmContracts {
    pub mailbox: H160,
    pub hook: H160,
    pub paymaster: H160,
}

#[async_trait]
impl BuildableWithProvider for SourceBuilder {
    type Output = Box<dyn Source>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        _locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EvmSource {
            provider,
            contracts: self.contracts.clone(),
            domain: self.domain,
        })
    }
}

struct EvmSource<M> {
    provider: M,
    contracts: EvmContracts,
    domain: u32,
}

impl<M: Middleware + 'static> EvmSource<M> {
    async fn count(&self, address: H160, signature: &str, hash: EthersH256) -> Result<u32> {
        let call = TransactionRequest::new()
            .to(address)
            .data(ethers::utils::id(signature)[..4].to_vec())
            .into();
        let result = self.provider.call(&call, Some(BlockId::Hash(hash))).await?;
        if result.is_empty()
            && self
                .provider
                .get_code(address, Some(BlockId::Hash(hash)))
                .await?
                .is_empty()
        {
            return Ok(0); // The range may start before the contract was deployed.
        }
        ensure!(result.len() == 32, "Invalid contract sequence count");
        let value = U256::from_big_endian(&result);
        ensure!(
            value <= U256::from(u32::MAX),
            "Contract sequence count overflow"
        );
        Ok(value.as_u32())
    }
}

#[async_trait]
impl<M: Middleware + 'static> Source for EvmSource<M> {
    async fn header(&self, selector: BlockSelector) -> Result<Header> {
        let number = match selector {
            BlockSelector::Height(height) => BlockNumber::Number(height.into()),
            BlockSelector::Latest => BlockNumber::Latest,
            BlockSelector::Safe => BlockNumber::Safe,
            BlockSelector::Finalized => BlockNumber::Finalized,
        };
        let block = self
            .provider
            .get_block(BlockId::Number(number))
            .await?
            .ok_or_else(|| eyre!("Missing stream block {number:?}"))?;
        let height = block
            .number
            .ok_or_else(|| eyre!("Missing block number"))?
            .as_u64();
        if let BlockNumber::Number(expected) = number {
            ensure!(
                height == expected.as_u64(),
                "RPC returned incorrect block height"
            );
        }
        Ok(Header {
            height,
            timestamp: block.timestamp.as_u64(),
            hash: block.hash.ok_or_else(|| eyre!("Missing block hash"))?,
            parent: block.parent_hash,
        })
    }

    async fn counts(&self, hash: EthersH256) -> Result<[u32; 2]> {
        let (dispatches, insertions) = tokio::try_join!(
            self.count(self.contracts.mailbox, "nonce()", hash),
            self.count(self.contracts.hook, "count()", hash),
        )?;
        Ok([dispatches, insertions])
    }

    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        ensure!(from <= through, "Invalid event range");
        let filter = Filter::new()
            .from_block(from)
            .to_block(through)
            .address(vec![
                self.contracts.mailbox,
                self.contracts.hook,
                self.contracts.paymaster,
            ])
            .topic0(vec![
                DispatchFilter::signature(),
                ProcessIdFilter::signature(),
                InsertedIntoTreeFilter::signature(),
                GasPaymentFilter::signature(),
            ]);
        let logs = self.provider.get_logs(&filter).await?;
        let mut events = Vec::new();
        for log in logs {
            ensure!(
                log.block_hash.is_some()
                    && log
                        .block_number
                        .is_some_and(|height| (from..=through).contains(&height.as_u64()))
                    && !log.removed.unwrap_or(false),
                "RPC returned an event from a different block"
            );
            if let Some(event) = decode(&self.contracts, self.domain, log)? {
                events.push(event);
            }
        }
        events.sort_by_key(|event| (event.block_number, event.tx_index, event.log_index));
        ensure!(
            events.windows(2).all(|pair| {
                (pair[0].block_number, pair[0].tx_index, pair[0].log_index)
                    != (pair[1].block_number, pair[1].tx_index, pair[1].log_index)
            }),
            "Duplicate event position"
        );
        // Positions include the transaction index, so one transaction reported at
        // two indexes would otherwise store the same log twice.
        let mut tx_positions = HashMap::new();
        for event in &events {
            let previous = tx_positions.insert((event.block_hash, event.tx_hash), event.tx_index);
            ensure!(
                previous.is_none_or(|index| index == event.tx_index),
                "RPC reported one transaction at two indexes"
            );
        }
        Ok(events)
    }
}

fn decode(contracts: &EvmContracts, domain: u32, log: Log) -> Result<Option<Event>> {
    let topic = log
        .topics
        .first()
        .copied()
        .ok_or_else(|| eyre!("Missing event signature"))?;
    let raw = RawLog {
        topics: log.topics.clone(),
        data: log.data.to_vec(),
    };
    let data = if log.address == contracts.mailbox && topic == DispatchFilter::signature() {
        let event = DispatchFilter::decode_log(&raw)?;
        let message = HyperlaneMessage::read_from(&mut event.message.as_ref())?;
        ensure!(
            message.origin == domain
                && message.destination == event.destination
                && message.recipient.as_bytes() == event.recipient
                && message.sender.as_bytes() == EthersH256::from(event.sender).as_bytes(),
            "Dispatch fields disagree with message"
        );
        EventData::Dispatch(message)
    } else if log.address == contracts.mailbox && topic == ProcessIdFilter::signature() {
        EventData::Delivery(H256::from_slice(
            &ProcessIdFilter::decode_log(&raw)?.message_id,
        ))
    } else if log.address == contracts.hook && topic == InsertedIntoTreeFilter::signature() {
        let event = InsertedIntoTreeFilter::decode_log(&raw)?;
        EventData::Insertion {
            index: event.index,
            message_id: H256::from_slice(&event.message_id),
        }
    } else if log.address == contracts.paymaster && topic == GasPaymentFilter::signature() {
        let event = GasPaymentFilter::decode_log(&raw)?;
        EventData::Gas {
            message_id: H256::from_slice(&event.message_id),
            destination: event.destination_domain,
            gas: event.gas_amount.to_string(),
            payment: event.payment.to_string(),
        }
    } else {
        return Ok(None);
    };
    let log_index = log.log_index.ok_or_else(|| eyre!("Missing log index"))?;
    ensure!(log_index <= i64::MAX.into(), "Log index too large");
    Ok(Some(Event {
        block_number: log
            .block_number
            .ok_or_else(|| eyre!("Missing block number"))?
            .as_u64(),
        block_hash: log.block_hash.ok_or_else(|| eyre!("Missing block hash"))?,
        data,
        address: log.address.into(),
        tx_hash: Some(
            log.transaction_hash
                .ok_or_else(|| eyre!("Missing transaction hash"))?
                .into(),
        ),
        tx_index: log
            .transaction_index
            .ok_or_else(|| eyre!("Missing transaction index"))?
            .as_u64(),
        log_index: log_index.as_u64(),
        sequence: None,
    }))
}

pub(super) struct GenericSource {
    provider: Box<dyn HyperlaneProvider>,
    messages: Box<dyn SequenceAwareIndexer<HyperlaneMessage>>,
    deliveries: Box<dyn SequenceAwareIndexer<H256>>,
    payments: Box<dyn SequenceAwareIndexer<InterchainGasPayment>>,
    insertions: Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>,
    contracts: Contracts,
    sequence_mode: bool,
    derive_insertions_from_messages: bool,
    complete_block_ranges: bool,
    chunk_size: u32,
    headers: RwLock<HashMap<u64, Header>>,
    count_checkpoints: RwLock<[BTreeMap<u32, u32>; 4]>,
}

impl GenericSource {
    const COUNT_CHECKPOINT_LIMIT: usize = 10_000;

    pub async fn build(
        conf: &ChainConf,
        metrics: &CoreMetrics,
        contracts: Contracts,
    ) -> Result<Box<dyn Source>> {
        let provider = conf.build_provider(metrics).await?;
        let messages = conf.build_message_indexer(metrics, true).await?;
        let deliveries = conf.build_delivery_indexer(metrics, true).await?;
        let payments = conf
            .build_interchain_gas_payment_indexer(metrics, true)
            .await?;
        let insertions = conf.build_merkle_tree_hook_indexer(metrics, false).await?;
        Ok(Box::new(Self {
            provider,
            messages,
            deliveries,
            payments,
            insertions,
            contracts,
            sequence_mode: matches!(conf.index.mode, IndexMode::Sequence),
            derive_insertions_from_messages: matches!(
                conf.connection.protocol(),
                HyperlaneDomainProtocol::Sealevel
            ),
            // Radix's paginated transaction stream rejects a range until the
            // Gateway API has reached its end, then scans every page through it.
            complete_block_ranges: matches!(
                conf.connection.protocol(),
                HyperlaneDomainProtocol::Radix
            ),
            chunk_size: conf.index.chunk_size,
            headers: RwLock::new(HashMap::new()),
            count_checkpoints: RwLock::new(std::array::from_fn(|_| BTreeMap::new())),
        }))
    }

    async fn latest_streams(&self) -> Result<[(Option<u32>, u32); 4]> {
        let (messages, deliveries, payments, insertions) = tokio::try_join!(
            self.messages.latest_sequence_count_and_tip(),
            self.deliveries.latest_sequence_count_and_tip(),
            self.payments.latest_sequence_count_and_tip(),
            self.insertions.latest_sequence_count_and_tip(),
        )?;
        let streams = [messages, deliveries, payments, insertions];
        let mut checkpoints = self.count_checkpoints.write().await;
        for (history, (count, tip)) in checkpoints.iter_mut().zip(streams) {
            if let Some(count) = count {
                history.insert(tip, count);
                while history.len() > Self::COUNT_CHECKPOINT_LIMIT {
                    history.pop_first();
                }
            }
        }
        Ok(streams)
    }

    async fn pinned_counts(&self, height: u32) -> [Option<u32>; 4] {
        let checkpoints = self.count_checkpoints.read().await;
        std::array::from_fn(|stream| checkpoints[stream].get(&height).copied())
    }

    fn event<T>(
        indexed: &Indexed<T>,
        meta: LogMeta,
        address: H256,
        data: EventData,
    ) -> Result<Event> {
        ensure!(meta.log_index <= u64::MAX.into(), "Log index too large");
        Ok(Event {
            block_number: meta.block_number,
            block_hash: meta.block_hash.into(),
            address,
            tx_hash: (!meta.transaction_id.is_zero()).then_some(meta.transaction_id),
            tx_index: meta.transaction_index,
            log_index: meta.log_index.as_u64(),
            sequence: indexed.sequence,
            data,
        })
    }

    async fn logs<T: Send + Sync + 'static>(
        indexer: &dyn SequenceAwareIndexer<T>,
        blocks: std::ops::RangeInclusive<u32>,
        next_sequence: u32,
        sequence_mode: bool,
        chunk_size: u32,
        pinned_count: Option<u32>,
    ) -> Result<(Vec<(Indexed<T>, LogMeta)>, u32, Option<u32>, bool)> {
        let (count, tip) = indexer.latest_sequence_count_and_tip().await?;
        let count_capable = count.is_some();
        ensure!(
            tip >= *blocks.end(),
            "Event-stream tip is behind the range boundary"
        );
        if let (Some(count), Some(pinned_count)) = (count, pinned_count) {
            ensure!(
                count >= pinned_count,
                "Provider sequence count regressed behind a pinned boundary"
            );
        }
        if !sequence_mode {
            return Ok((
                indexer.fetch_logs_in_range(blocks.clone()).await?,
                *blocks.end(),
                (tip == *blocks.end())
                    .then_some(count)
                    .flatten()
                    .or(count.and(pinned_count)),
                count_capable,
            ));
        }
        let count = count.ok_or_else(|| eyre!("Indexer does not expose a sequence count"))?;
        ensure!(
            count >= next_sequence,
            "Provider sequence count is behind durable history"
        );
        if count == next_sequence {
            return Ok((Vec::new(), tip.min(*blocks.end()), None, true));
        }
        ensure!(chunk_size > 0, "index.chunk must be positive");
        let mut logs = Vec::new();
        let mut start = next_sequence;
        let mut previous_block = None;
        let mut first_block = None;
        let mut indexed_through = None;
        while start < count {
            let end = count
                .saturating_sub(1)
                .min(start.saturating_add(chunk_size).saturating_sub(1));
            let mut page = indexer.fetch_logs_in_range(start..=end).await?;
            page.sort_by_key(|(indexed, _)| indexed.sequence);
            let mut expected = start;
            for (indexed, meta) in &page {
                ensure!(
                    indexed.sequence == Some(expected),
                    "Indexer returned an incomplete sequence page"
                );
                ensure!(
                    previous_block.is_none_or(|height| height <= meta.block_number),
                    "Indexer returned sequences out of block order"
                );
                previous_block = Some(meta.block_number);
                expected = expected
                    .checked_add(1)
                    .ok_or_else(|| eyre!("Sequence range overflow"))?;
            }
            ensure!(
                expected == end.saturating_add(1),
                "Indexer returned an incomplete sequence page"
            );
            let beyond_boundary = page
                .last()
                .is_some_and(|(_, meta)| meta.block_number > u64::from(*blocks.end()));
            let first_page_block = page
                .first()
                .map(|(_, meta)| u32::try_from(meta.block_number))
                .transpose()?
                .ok_or_else(|| eyre!("Sequence page omitted its requested events"))?;
            let last_block = page
                .last()
                .map(|(_, meta)| u32::try_from(meta.block_number))
                .transpose()?
                .ok_or_else(|| eyre!("Sequence page omitted its requested events"))?;
            first_block.get_or_insert(first_page_block);
            logs.extend(page);
            start = end
                .checked_add(1)
                .ok_or_else(|| eyre!("Sequence range overflow"))?;
            if beyond_boundary {
                indexed_through = Some(*blocks.end());
                break;
            }
            if start == count {
                indexed_through = Some(tip.min(*blocks.end()));
                break;
            }
            if Some(last_block) > first_block {
                indexed_through = Some(last_block.saturating_sub(1).min(*blocks.end()));
                break;
            }
        }
        Ok((
            logs,
            indexed_through.ok_or_else(|| eyre!("Sequence page made no progress"))?,
            None,
            true,
        ))
    }

    fn normalize_events(events: &mut Vec<Event>) {
        *events = std::mem::take(events)
            .into_iter()
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        events.sort_by_key(|event| {
            let (stream, sequence, id) = match &event.data {
                EventData::Dispatch(message) => (0, message.nonce, message.id()),
                EventData::Delivery(id) => (1, event.sequence.unwrap_or(u32::MAX), *id),
                EventData::Gas { message_id, .. } => {
                    (2, event.sequence.unwrap_or(u32::MAX), *message_id)
                }
                EventData::Insertion { message_id, index } => (3, *index, *message_id),
            };
            (
                event.block_number,
                stream,
                sequence,
                event.tx_index,
                event.log_index,
                id,
            )
        });
    }

    async fn fetch_header_at(&self, height: u64) -> hyperlane_core::ChainResult<Header> {
        let block = self.provider.get_block_by_height(height).await?;
        if block.number != height {
            return Err(
                hyperlane_core::HyperlaneProviderError::IncorrectBlockByHeight(
                    height,
                    block.number,
                )
                .into(),
            );
        }
        Ok(Header {
            height,
            timestamp: block.timestamp,
            hash: block.hash.into(),
            parent: EthersH256::zero(),
        })
    }

    async fn header_at(&self, height: u64) -> hyperlane_core::ChainResult<Header> {
        if let Some(header) = self.headers.read().await.get(&height).cloned() {
            return Ok(header);
        }
        let header = self.fetch_header_at(height).await?;
        self.headers.write().await.insert(height, header.clone());
        Ok(header)
    }

    async fn fresh_header_at(&self, height: u64) -> hyperlane_core::ChainResult<Header> {
        let header = self.fetch_header_at(height).await?;
        self.headers.write().await.insert(height, header.clone());
        Ok(header)
    }

    async fn selected_height(&self, selector: BlockSelector) -> Result<u64> {
        match selector {
            BlockSelector::Height(height) => Ok(height),
            BlockSelector::Latest => Ok(self
                .provider
                .get_chain_metrics()
                .await?
                .ok_or_else(|| eyre!("Provider omitted chain height"))?
                .block_height),
            BlockSelector::Safe | BlockSelector::Finalized => Ok(u64::from(
                self.messages.latest_sequence_count_and_tip().await?.1,
            )),
        }
    }

    async fn range_end_with_freshness(
        &self,
        after: u64,
        through: u64,
        head: u64,
        fresh: bool,
    ) -> Result<Header> {
        ensure!(after < through, "Empty indexing range");
        ensure!(through <= head, "Range boundary is ahead of head");
        let mut first_error = None;
        for height in (after.saturating_add(1)..=through).rev() {
            let result = if fresh {
                self.fresh_header_at(height).await
            } else {
                self.header_at(height).await
            };
            match result {
                Ok(header) => return Ok(header),
                Err(error) if self.provider.is_block_unavailable(&error) => {
                    first_error.get_or_insert(eyre::Report::new(error));
                }
                Err(error) => return Err(error.into()),
            }
        }
        // An entire chunk may consist of skipped slots. Advance to the first
        // real block after it without treating nonexistent slots as headers.
        let limit = head.min(through.saturating_add(through.saturating_sub(after)));
        for height in through.saturating_add(1)..=limit {
            let result = if fresh {
                self.fresh_header_at(height).await
            } else {
                self.header_at(height).await
            };
            match result {
                Ok(header) => return Ok(header),
                Err(error) if self.provider.is_block_unavailable(&error) => {
                    first_error.get_or_insert(eyre::Report::new(error));
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(first_error.unwrap_or_else(|| eyre!("No canonical block in indexing range")))
    }
}

#[async_trait]
impl Source for GenericSource {
    async fn begin_cycle(&self) {
        self.headers.write().await.clear();
    }

    async fn header(&self, selector: BlockSelector) -> Result<Header> {
        let height = self.selected_height(selector).await?;
        Ok(self.header_at(height).await?)
    }

    async fn fresh_header(&self, selector: BlockSelector) -> Result<Header> {
        let height = self.selected_height(selector).await?;
        Ok(self.fresh_header_at(height).await?)
    }

    async fn range_end(&self, after: u64, through: u64, head: u64) -> Result<Header> {
        self.range_end_with_freshness(after, through, head, false)
            .await
    }

    async fn fresh_range_end(&self, after: u64, through: u64, head: u64) -> Result<Header> {
        self.range_end_with_freshness(after, through, head, true)
            .await
    }

    async fn counts(&self, _hash: EthersH256) -> Result<[u32; 2]> {
        eyre::bail!("Historical sequence counts are unsupported")
    }

    fn has_historical_counts(&self) -> bool {
        false
    }

    fn indexes_by_sequence(&self) -> bool {
        self.sequence_mode
    }

    fn block_ranges_are_complete(&self) -> bool {
        self.complete_block_ranges
    }

    async fn indexing_tip(&self) -> Result<Option<u64>> {
        let [messages, deliveries, payments, insertions] = self.latest_streams().await?;
        Ok([messages.1, deliveries.1, payments.1, insertions.1]
            .into_iter()
            .min()
            .map(u64::from))
    }

    async fn empty_anchor(&self) -> Result<Option<Header>> {
        let [messages, deliveries, payments, insertions] = self.latest_streams().await?;
        let streams = [messages, deliveries, payments, insertions];
        if !streams.iter().all(|(count, _)| *count == Some(0)) {
            return Ok(None);
        }
        let tip = streams
            .into_iter()
            .map(|(_, tip)| tip)
            .min()
            .ok_or_else(|| eyre!("Missing event-stream tip"))?;
        Ok(Some(
            self.header(BlockSelector::Height(u64::from(tip))).await?,
        ))
    }

    async fn events(&self, from: u64, through: u64) -> Result<Vec<Event>> {
        Ok(self.events_after(from, through, [0; 4]).await?.events)
    }

    async fn events_after(
        &self,
        from: u64,
        through: u64,
        sequences: [u32; 4],
    ) -> Result<EventBatch> {
        ensure!(from <= through, "Invalid event range");
        if self.derive_insertions_from_messages {
            ensure!(
                sequences[0] == sequences[3],
                "Sealevel dispatch and insertion history diverged"
            );
        }
        let range = u32::try_from(from)?..=u32::try_from(through)?;
        let pinned_counts = self.pinned_counts(*range.end()).await;
        let (messages, deliveries, payments, insertions) = tokio::try_join!(
            Self::logs(
                self.messages.as_ref(),
                range.clone(),
                sequences[0],
                self.sequence_mode,
                self.chunk_size,
                pinned_counts[0],
            ),
            Self::logs(
                self.deliveries.as_ref(),
                range.clone(),
                sequences[1],
                self.sequence_mode,
                self.chunk_size,
                pinned_counts[1],
            ),
            Self::logs(
                self.payments.as_ref(),
                range.clone(),
                sequences[2],
                self.sequence_mode,
                self.chunk_size,
                pinned_counts[2],
            ),
            async {
                if self.derive_insertions_from_messages {
                    Ok((Vec::new(), u32::try_from(through)?, None, true))
                } else {
                    Self::logs(
                        self.insertions.as_ref(),
                        range,
                        sequences[3],
                        self.sequence_mode,
                        self.chunk_size,
                        pinned_counts[3],
                    )
                    .await
                }
            },
        )?;
        let (messages, message_through, message_count, message_count_capable) = messages;
        let (deliveries, delivery_through, delivery_count, delivery_count_capable) = deliveries;
        let (payments, payment_through, payment_count, payment_count_capable) = payments;
        let (insertions, mut insertion_through, mut insertion_count, mut insertion_count_capable) =
            insertions;
        if self.derive_insertions_from_messages {
            insertion_through = message_through;
            insertion_count = message_count;
            insertion_count_capable = message_count_capable;
        }
        let indexed_through = [
            message_through,
            delivery_through,
            payment_through,
            insertion_through,
        ]
        .into_iter()
        .min()
        .ok_or_else(|| eyre!("Missing stream coverage"))?;
        let capacity = messages
            .len()
            .saturating_add(deliveries.len())
            .saturating_add(payments.len())
            .saturating_add(insertions.len());
        let mut events = Vec::with_capacity(capacity);
        for (indexed, meta) in messages {
            let data = EventData::Dispatch(indexed.inner().clone());
            events.push(Self::event(
                &indexed,
                meta.clone(),
                self.contracts.mailbox,
                data,
            )?);
            if self.derive_insertions_from_messages {
                let data = EventData::Insertion {
                    message_id: indexed.inner().id(),
                    index: indexed.inner().nonce,
                };
                events.push(Self::event(&indexed, meta, self.contracts.hook, data)?);
            }
        }
        for (indexed, meta) in deliveries {
            let data = EventData::Delivery(*indexed.inner());
            events.push(Self::event(&indexed, meta, self.contracts.mailbox, data)?);
        }
        for (indexed, meta) in payments {
            let payment = *indexed.inner();
            let data = EventData::Gas {
                message_id: payment.message_id,
                destination: payment.destination,
                gas: payment.gas_amount.to_string(),
                payment: payment.payment.to_string(),
            };
            events.push(Self::event(&indexed, meta, self.contracts.paymaster, data)?);
        }
        for (indexed, meta) in insertions {
            let insertion = *indexed.inner();
            let data = EventData::Insertion {
                message_id: insertion.message_id(),
                index: insertion.index(),
            };
            events.push(Self::event(&indexed, meta, self.contracts.hook, data)?);
        }
        Self::normalize_events(&mut events);
        // Sequence tips can advance after the observed head. Defer those events
        // until their blocks are included in a later observation.
        events.retain(|event| event.block_number <= u64::from(indexed_through));
        Ok(EventBatch {
            events,
            indexed_through: Some(u64::from(indexed_through)),
            end_counts: [
                message_count,
                delivery_count,
                payment_count,
                insertion_count,
            ],
            count_capable: [
                message_count_capable,
                delivery_count_capable,
                payment_count_capable,
                insertion_count_capable,
            ],
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{
        marker::PhantomData,
        ops::RangeInclusive,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    use ethers::{
        abi::{encode, Token},
        providers::Provider,
    };

    use super::*;

    #[derive(Debug)]
    struct EmptyIndexer<T>(PhantomData<T>);

    #[async_trait]
    impl<T: Send + Sync + std::fmt::Debug> hyperlane_core::Indexer<T> for EmptyIndexer<T> {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> hyperlane_core::ChainResult<Vec<(Indexed<T>, LogMeta)>> {
            Ok(Vec::new())
        }

        async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
            Ok(7)
        }
    }

    #[async_trait]
    impl<T: Send + Sync + std::fmt::Debug> SequenceAwareIndexer<T> for EmptyIndexer<T> {
        async fn latest_sequence_count_and_tip(
            &self,
        ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
            Ok((Some(0), 7))
        }
    }

    #[derive(Clone, Debug)]
    struct CountingProvider {
        domain: hyperlane_core::HyperlaneDomain,
        calls: Arc<AtomicUsize>,
    }

    impl hyperlane_core::HyperlaneChain for CountingProvider {
        fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
            &self.domain
        }

        fn provider(&self) -> Box<dyn HyperlaneProvider> {
            Box::new(self.clone())
        }
    }

    #[async_trait]
    impl HyperlaneProvider for CountingProvider {
        async fn get_block_by_height(
            &self,
            height: u64,
        ) -> hyperlane_core::ChainResult<hyperlane_core::BlockInfo> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(hyperlane_core::BlockInfo {
                hash: H256::from_low_u64_be(height),
                timestamp: height,
                number: height,
            })
        }

        async fn get_txn_by_hash(
            &self,
            _hash: &H512,
        ) -> hyperlane_core::ChainResult<hyperlane_core::TxnInfo> {
            Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "unused test RPC",
            ))
        }

        async fn is_contract(&self, _address: &H256) -> hyperlane_core::ChainResult<bool> {
            Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "unused test RPC",
            ))
        }

        async fn get_balance(
            &self,
            _address: String,
        ) -> hyperlane_core::ChainResult<hyperlane_core::U256> {
            Err(hyperlane_core::ChainCommunicationError::from_other_str(
                "unused test RPC",
            ))
        }

        async fn get_chain_metrics(
            &self,
        ) -> hyperlane_core::ChainResult<Option<hyperlane_core::ChainInfo>> {
            Ok(Some(hyperlane_core::ChainInfo::new(7, None)))
        }
    }

    #[tokio::test]
    async fn generic_headers_are_cached_per_cycle_with_explicit_fresh_reads() -> Result<()> {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = GenericSource {
            provider: Box::new(CountingProvider {
                domain: hyperlane_core::HyperlaneDomain::new_test_domain("header-cache"),
                calls: calls.clone(),
            }),
            messages: Box::new(EmptyIndexer::<HyperlaneMessage>(PhantomData)),
            deliveries: Box::new(EmptyIndexer::<H256>(PhantomData)),
            payments: Box::new(EmptyIndexer::<InterchainGasPayment>(PhantomData)),
            insertions: Box::new(EmptyIndexer::<MerkleTreeInsertion>(PhantomData)),
            contracts: Contracts {
                mailbox: H256::zero(),
                hook: H256::zero(),
                paymaster: H256::zero(),
            },
            sequence_mode: false,
            derive_insertions_from_messages: false,
            complete_block_ranges: false,
            chunk_size: 1,
            headers: RwLock::new(HashMap::new()),
            count_checkpoints: RwLock::new(std::array::from_fn(|_| BTreeMap::new())),
        };

        source.begin_cycle().await;
        source.header(BlockSelector::Height(7)).await?;
        source.header(BlockSelector::Height(7)).await?;
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        source.fresh_header(BlockSelector::Height(7)).await?;
        source.header(BlockSelector::Height(7)).await?;
        assert_eq!(calls.load(Ordering::Relaxed), 2);

        source.begin_cycle().await;
        source.header(BlockSelector::Height(7)).await?;
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        Ok(())
    }

    #[tokio::test]
    async fn empty_anchor_uses_the_zero_count_common_tip() -> Result<()> {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = GenericSource {
            provider: Box::new(CountingProvider {
                domain: hyperlane_core::HyperlaneDomain::new_test_domain("empty-anchor"),
                calls,
            }),
            messages: Box::new(EmptyIndexer::<HyperlaneMessage>(PhantomData)),
            deliveries: Box::new(EmptyIndexer::<H256>(PhantomData)),
            payments: Box::new(EmptyIndexer::<InterchainGasPayment>(PhantomData)),
            insertions: Box::new(EmptyIndexer::<MerkleTreeInsertion>(PhantomData)),
            contracts: Contracts {
                mailbox: H256::zero(),
                hook: H256::zero(),
                paymaster: H256::zero(),
            },
            sequence_mode: true,
            derive_insertions_from_messages: false,
            complete_block_ranges: false,
            chunk_size: 1,
            headers: RwLock::new(HashMap::new()),
            count_checkpoints: RwLock::new(std::array::from_fn(|_| BTreeMap::new())),
        };

        assert_eq!(
            source.empty_anchor().await?,
            Some(Header {
                height: 7,
                timestamp: 7,
                hash: EthersH256::from_low_u64_be(7),
                parent: EthersH256::zero(),
            })
        );
        Ok(())
    }

    #[derive(Debug)]
    struct SequenceIndexer {
        count: u32,
        tip: u32,
        truncate_last: bool,
        requests: Mutex<Vec<RangeInclusive<u32>>>,
    }

    #[derive(Debug)]
    struct AdvancingTipIndexer<T> {
        calls: AtomicUsize,
        marker: PhantomData<T>,
    }

    fn advancing_indexer<T>() -> AdvancingTipIndexer<T> {
        AdvancingTipIndexer {
            calls: AtomicUsize::new(0),
            marker: PhantomData,
        }
    }

    #[async_trait]
    impl<T: Send + Sync + std::fmt::Debug> hyperlane_core::Indexer<T> for AdvancingTipIndexer<T> {
        async fn fetch_logs_in_range(
            &self,
            _range: RangeInclusive<u32>,
        ) -> hyperlane_core::ChainResult<Vec<(Indexed<T>, LogMeta)>> {
            Ok(Vec::new())
        }

        async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
            Ok(200)
        }
    }

    #[async_trait]
    impl<T: Send + Sync + std::fmt::Debug> SequenceAwareIndexer<T> for AdvancingTipIndexer<T> {
        async fn latest_sequence_count_and_tip(
            &self,
        ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
            Ok((
                Some(0),
                200_u32.saturating_add(
                    u32::try_from(self.calls.fetch_add(1, Ordering::SeqCst)).unwrap_or(u32::MAX),
                ),
            ))
        }
    }

    #[tokio::test]
    async fn block_counts_remain_pinned_when_tips_advance_during_fetch() -> Result<()> {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = GenericSource {
            provider: Box::new(CountingProvider {
                domain: hyperlane_core::HyperlaneDomain::new_test_domain("moving-tip"),
                calls,
            }),
            messages: Box::new(advancing_indexer()),
            deliveries: Box::new(advancing_indexer()),
            payments: Box::new(advancing_indexer()),
            insertions: Box::new(advancing_indexer()),
            contracts: Contracts {
                mailbox: H256::zero(),
                hook: H256::zero(),
                paymaster: H256::zero(),
            },
            sequence_mode: false,
            derive_insertions_from_messages: false,
            complete_block_ranges: false,
            chunk_size: 1_000,
            headers: RwLock::new(HashMap::new()),
            count_checkpoints: RwLock::new(std::array::from_fn(|_| BTreeMap::new())),
        };

        assert_eq!(source.indexing_tip().await?, Some(200));
        let batch = source.events_after(1, 200, [0; 4]).await?;
        assert_eq!(batch.end_counts, [Some(0); 4]);
        Ok(())
    }

    #[async_trait]
    impl hyperlane_core::Indexer<HyperlaneMessage> for SequenceIndexer {
        async fn fetch_logs_in_range(
            &self,
            range: RangeInclusive<u32>,
        ) -> hyperlane_core::ChainResult<Vec<(Indexed<HyperlaneMessage>, LogMeta)>> {
            self.requests
                .lock()
                .expect("request mutex poisoned")
                .push(range.clone());
            let mut logs: Vec<_> = range
                .map(|sequence| {
                    (
                        Indexed::new(HyperlaneMessage::default()).with_sequence(sequence),
                        LogMeta {
                            block_number: u64::from(sequence),
                            ..LogMeta::default()
                        },
                    )
                })
                .collect();
            if self.truncate_last {
                logs.pop();
            }
            Ok(logs)
        }

        async fn get_finalized_block_number(&self) -> hyperlane_core::ChainResult<u32> {
            Ok(200)
        }
    }

    #[async_trait]
    impl SequenceAwareIndexer<HyperlaneMessage> for SequenceIndexer {
        async fn latest_sequence_count_and_tip(
            &self,
        ) -> hyperlane_core::ChainResult<(Option<u32>, u32)> {
            Ok((Some(self.count), self.tip))
        }
    }

    #[tokio::test]
    async fn sequence_mode_translates_durable_count_to_sequence_range() -> Result<()> {
        let indexer = SequenceIndexer {
            count: 10,
            tip: 200,
            truncate_last: false,
            requests: Mutex::new(Vec::new()),
        };
        GenericSource::logs(&indexer, 100..=200, 7, true, 2, None).await?;
        assert_eq!(
            *indexer.requests.lock().expect("request mutex poisoned"),
            vec![7..=8]
        );
        indexer
            .requests
            .lock()
            .expect("request mutex poisoned")
            .clear();
        let (_, indexed_through, end_count, count_capable) =
            GenericSource::logs(&indexer, 100..=200, 7, false, 2, None).await?;
        assert_eq!(indexed_through, 200);
        assert_eq!(end_count, Some(10));
        assert!(count_capable);
        assert_eq!(
            *indexer.requests.lock().expect("request mutex poisoned"),
            vec![100..=200]
        );

        assert!(GenericSource::logs(&indexer, 100..=200, 11, true, 2, None)
            .await
            .is_err());

        let partial = SequenceIndexer {
            count: 10,
            tip: 200,
            truncate_last: true,
            requests: Mutex::new(Vec::new()),
        };
        assert!(GenericSource::logs(&partial, 100..=200, 7, true, 10, None)
            .await
            .is_err());

        let bounded = SequenceIndexer {
            count: 100,
            tip: 200,
            truncate_last: false,
            requests: Mutex::new(Vec::new()),
        };
        let bounded_result = GenericSource::logs(&bounded, 0..=3, 0, true, 2, None).await?;
        assert_eq!(bounded_result.1, 0);
        assert_eq!(bounded_result.2, None);
        assert_eq!(
            *bounded.requests.lock().expect("request mutex poisoned"),
            vec![0..=1]
        );
        let lagging = SequenceIndexer {
            count: 10,
            tip: 199,
            truncate_last: false,
            requests: Mutex::new(Vec::new()),
        };
        assert!(GenericSource::logs(&lagging, 100..=200, 7, true, 2, None)
            .await
            .is_err());
        assert!(lagging
            .requests
            .lock()
            .expect("request mutex poisoned")
            .is_empty());
        Ok(())
    }

    #[test]
    fn generic_events_are_deduplicated_without_rewriting_log_positions() -> Result<()> {
        let event = |block_number, log_index| Event {
            block_number,
            block_hash: EthersH256::zero(),
            address: H256::zero(),
            tx_hash: None,
            tx_index: 0,
            log_index,
            sequence: None,
            data: EventData::Gas {
                message_id: H256::zero(),
                destination: 0,
                gas: "0".into(),
                payment: "0".into(),
            },
        };
        let repeated = event(7, 0);
        let mut distinct = event(7, 0);
        distinct.data = EventData::Gas {
            message_id: H256::repeat_byte(1),
            destination: 0,
            gas: "0".into(),
            payment: "0".into(),
        };
        let mut events = vec![repeated.clone(), distinct, repeated, event(8, 0)];
        GenericSource::normalize_events(&mut events);
        assert_eq!(
            events
                .into_iter()
                .map(|event| event.log_index)
                .collect::<Vec<_>>(),
            vec![0, 0, 0]
        );

        let delivery = |sequence, tx_index| Event {
            block_number: 9,
            block_hash: EthersH256::zero(),
            address: H256::zero(),
            tx_hash: None,
            tx_index,
            log_index: 0,
            sequence: Some(sequence),
            data: EventData::Delivery(H256::from_low_u64_be(u64::from(sequence))),
        };
        let mut mixed_metadata = vec![delivery(7, 2), delivery(8, 0)];
        GenericSource::normalize_events(&mut mixed_metadata);
        assert_eq!(
            mixed_metadata
                .into_iter()
                .map(|event| event.sequence)
                .collect::<Vec<_>>(),
            vec![Some(7), Some(8)]
        );
        Ok(())
    }

    #[derive(Debug)]
    struct ConcurrentCounts {
        inner: Provider<ethers::providers::MockProvider>,
        started: tokio::sync::Barrier,
        hash: EthersH256,
    }

    #[async_trait]
    impl Middleware for ConcurrentCounts {
        type Error = ethers::providers::ProviderError;
        type Provider = ethers::providers::MockProvider;
        type Inner = Provider<Self::Provider>;

        fn inner(&self) -> &Self::Inner {
            &self.inner
        }

        async fn call(
            &self,
            tx: &ethers::types::transaction::eip2718::TypedTransaction,
            block: Option<BlockId>,
        ) -> std::result::Result<ethers::types::Bytes, Self::Error> {
            assert_eq!(block, Some(BlockId::Hash(self.hash)));
            // Neither reply is available until both independent requests start.
            self.started.wait().await;
            let count: u32 = if tx.to() == Some(&H160::repeat_byte(1).into()) {
                9
            } else {
                7
            };
            Ok(encode(&[Token::Uint(count.into())]).into())
        }
    }

    #[tokio::test]
    async fn sequence_count_requests_run_concurrently() -> Result<()> {
        let (inner, _) = Provider::mocked();
        let hash = EthersH256::repeat_byte(4);
        let source = EvmSource {
            provider: ConcurrentCounts {
                inner,
                started: tokio::sync::Barrier::new(2),
                hash,
            },
            contracts: EvmContracts {
                mailbox: H160::repeat_byte(1),
                hook: H160::repeat_byte(2),
                paymaster: H160::repeat_byte(3),
            },
            domain: 1,
        };
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), source.counts(hash)).await??,
            [9, 7]
        );
        Ok(())
    }

    #[tokio::test]
    async fn sequence_counts_are_hash_pinned_and_reject_malformed_contract_replies() -> Result<()> {
        use ethers::types::Bytes;
        let (provider, rpc) = Provider::mocked();
        let source = EvmSource {
            provider,
            contracts: EvmContracts {
                mailbox: H160::repeat_byte(1),
                hook: H160::repeat_byte(2),
                paymaster: H160::repeat_byte(3),
            },
            domain: 1,
        };
        let hash = EthersH256::repeat_byte(4);
        let encoded = |value: u32| Bytes::from(encode(&[Token::Uint(value.into())]));
        rpc.push::<Bytes, _>(encoded(7))?;
        rpc.push::<Bytes, _>(encoded(9))?;
        assert_eq!(source.counts(hash).await?, [9, 7]);
        for (address, signature) in [
            (source.contracts.mailbox, "nonce()"),
            (source.contracts.hook, "count()"),
        ] {
            let call: ethers::types::transaction::eip2718::TypedTransaction =
                TransactionRequest::new()
                    .to(address)
                    .data(ethers::utils::id(signature)[..4].to_vec())
                    .into();
            rpc.assert_request("eth_call", (call, BlockId::Hash(hash)))?;
        }
        // Empty results only mean zero before deployment, never for existing code.
        rpc.push::<Bytes, _>(Bytes::from(vec![1]))?;
        rpc.push::<Bytes, _>(Bytes::default())?;
        assert!(source.counts(hash).await.is_err());
        rpc.push::<Bytes, _>(encoded(0))?;
        rpc.push::<Bytes, _>(Bytes::default())?;
        rpc.push::<Bytes, _>(Bytes::default())?;
        assert_eq!(source.counts(hash).await?, [0, 0]);
        rpc.push::<Bytes, _>(Bytes::from(encode(&[Token::Uint(
            U256::from(u32::MAX) + 1,
        )])))?;
        assert!(source.counts(hash).await.is_err());
        Ok(())
    }

    /// RPCs such as ENI number logs within each transaction. Ordering by log index
    /// alone would put nonce 1 (tx 1, log 0) before nonce 0 (tx 0, log 1).
    #[tokio::test]
    async fn dispatch_nonces_follow_chain_order_with_per_transaction_log_indexes() -> Result<()> {
        use hyperlane_core::Encode;

        let (provider, rpc) = Provider::mocked();
        let contracts = EvmContracts {
            mailbox: H160::repeat_byte(1),
            hook: H160::repeat_byte(2),
            paymaster: H160::repeat_byte(3),
        };
        let source = EvmSource {
            provider,
            contracts: contracts.clone(),
            domain: 1,
        };
        let sender = H160::repeat_byte(9);
        let dispatch = |nonce: u32, tx_index: u64, log_index: u64| {
            let message = HyperlaneMessage {
                version: 3,
                nonce,
                origin: 1,
                sender: EthersH256::from(sender).0.into(),
                destination: 2,
                recipient: hyperlane_core::H256::repeat_byte(2),
                body: vec![],
            };
            Log {
                address: contracts.mailbox,
                topics: vec![
                    DispatchFilter::signature(),
                    EthersH256::from(sender),
                    EthersH256::from_low_u64_be(2),
                    EthersH256::repeat_byte(2),
                ],
                data: encode(&[Token::Bytes(message.to_vec())]).into(),
                block_hash: Some(EthersH256::repeat_byte(4)),
                block_number: Some(10.into()),
                transaction_hash: Some(EthersH256::from_low_u64_be(100 + tx_index)),
                transaction_index: Some(tx_index.into()),
                log_index: Some(log_index.into()),
                removed: Some(false),
                ..Default::default()
            }
        };
        rpc.push::<Vec<Log>, _>(vec![dispatch(1, 1, 0), dispatch(0, 0, 1)])?;
        let events = source.events(10, 10).await?;
        let nonces = events
            .iter()
            .map(|event| match &event.data {
                EventData::Dispatch(message) => message.nonce,
                _ => unreachable!("only dispatches were returned"),
            })
            .collect::<Vec<_>>();
        assert_eq!(nonces, vec![0, 1]);
        super::super::validate_sequences(&events, [0, 0], [2, 0])?;
        Ok(())
    }

    #[tokio::test]
    async fn gas_logs_require_the_requested_occurrence_and_unique_positions() -> Result<()> {
        let (provider, rpc) = Provider::mocked();
        let contracts = EvmContracts {
            mailbox: H160::repeat_byte(1),
            hook: H160::repeat_byte(2),
            paymaster: H160::repeat_byte(3),
        };
        let source = EvmSource {
            provider,
            contracts: contracts.clone(),
            domain: 1,
        };
        let header = Header {
            height: 10,
            timestamp: 1,
            hash: EthersH256::repeat_byte(4),
            parent: EthersH256::repeat_byte(5),
        };
        let log = Log {
            address: contracts.paymaster,
            topics: vec![
                GasPaymentFilter::signature(),
                EthersH256::repeat_byte(6),
                EthersH256::from_low_u64_be(42161),
            ],
            data: encode(&[Token::Uint(123.into()), Token::Uint(456.into())]).into(),
            block_hash: Some(header.hash),
            block_number: Some(header.height.into()),
            transaction_hash: Some(EthersH256::repeat_byte(7)),
            transaction_index: Some(0.into()),
            log_index: Some(1.into()),
            removed: Some(false),
            ..Default::default()
        };
        rpc.push::<Vec<Log>, _>(vec![log.clone()])?;
        let events = source.events(header.height, header.height + 100).await?;
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0].data, EventData::Gas { destination: 42161, gas, payment, .. } if gas == "123" && payment == "456")
        );
        rpc.assert_request("eth_getLogs", serde_json::json!([{
            "fromBlock": "0xa", "toBlock": "0x6e",
            "address": [contracts.mailbox, contracts.hook, contracts.paymaster],
            "topics": [[DispatchFilter::signature(), ProcessIdFilter::signature(), InsertedIntoTreeFilter::signature(), GasPaymentFilter::signature()]]
        }]))?;
        for invalid in [
            Log {
                block_number: Some(9.into()),
                ..log.clone()
            },
            Log {
                block_hash: None,
                ..log.clone()
            },
            Log {
                removed: Some(true),
                ..log.clone()
            },
            Log {
                transaction_index: None,
                ..log.clone()
            },
        ] {
            rpc.push::<Vec<Log>, _>(vec![invalid])?;
            assert!(source
                .events(header.height, header.height + 100)
                .await
                .is_err());
        }
        // Log indexes are unique within a block, not across the whole range.
        rpc.push::<Vec<Log>, _>(vec![
            log.clone(),
            Log {
                block_number: Some(11.into()),
                block_hash: Some(header.parent),
                ..log.clone()
            },
        ])?;
        assert_eq!(
            source
                .events(header.height, header.height + 100)
                .await?
                .len(),
            2
        );
        // Some RPCs number logs within each transaction rather than across the block.
        rpc.push::<Vec<Log>, _>(vec![
            Log {
                transaction_hash: Some(EthersH256::repeat_byte(8)),
                transaction_index: Some(1.into()),
                ..log.clone()
            },
            log.clone(),
        ])?;
        let events = source.events(header.height, header.height + 100).await?;
        assert_eq!(
            events
                .iter()
                .map(|event| (event.tx_index, event.log_index))
                .collect::<Vec<_>>(),
            vec![(0, 1), (1, 1)]
        );
        rpc.push::<Vec<Log>, _>(vec![log.clone(), log.clone()])?;
        assert!(source
            .events(header.height, header.height + 100)
            .await
            .is_err());
        // The same transaction must not appear at two indexes, which would store
        // one log twice under different positions.
        rpc.push::<Vec<Log>, _>(vec![
            log.clone(),
            Log {
                transaction_index: Some(1.into()),
                ..log
            },
        ])?;
        assert!(source
            .events(header.height, header.height + 100)
            .await
            .unwrap_err()
            .to_string()
            .contains("one transaction at two indexes"));
        Ok(())
    }
}
