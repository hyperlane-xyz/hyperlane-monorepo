use std::collections::HashSet;

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
    pub watermarks: Option<[(Option<u32>, u32); 4]>,
    pub complete_through: Option<[bool; 4]>,
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
    async fn header(&self, block: BlockSelector) -> Result<Header>;
    async fn range_end(&self, after: u64, through: u64, _head: u64) -> Result<Header> {
        ensure!(after < through, "Empty indexing range");
        self.header(BlockSelector::Height(through)).await
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
            watermarks: None,
            complete_through: None,
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
    async fn publication_tip(&self) -> Result<Option<u64>> {
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
        events.sort_by_key(|event| (event.block_number, event.log_index));
        ensure!(
            events
                .windows(2)
                .all(|pair| (pair[0].block_number, pair[0].log_index)
                    != (pair[1].block_number, pair[1].log_index)),
            "Duplicate event position"
        );
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
    chunk_size: u32,
}

impl GenericSource {
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
            chunk_size: conf.index.chunk_size,
        }))
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
    ) -> Result<(Vec<(Indexed<T>, LogMeta)>, (Option<u32>, u32), bool)> {
        let watermark = indexer.latest_sequence_count_and_tip().await?;
        if sequence_mode {
            let Some(count) = watermark.0 else {
                return Ok((indexer.fetch_logs_in_range(blocks).await?, watermark, false));
            };
            ensure!(
                watermark.1 >= *blocks.end(),
                "Indexer sequence tip is behind the range boundary"
            );
            ensure!(
                count >= next_sequence,
                "Provider sequence count is behind durable history"
            );
            if count == next_sequence {
                return Ok((Vec::new(), watermark, true));
            }
            ensure!(chunk_size > 0, "index.chunk must be positive");
            let mut logs = Vec::new();
            let mut start = next_sequence;
            let mut previous_block = None;
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
                logs.extend(page);
                start = end
                    .checked_add(1)
                    .ok_or_else(|| eyre!("Sequence range overflow"))?;
                if beyond_boundary {
                    break;
                }
            }
            Ok((logs, watermark, true))
        } else {
            Ok((indexer.fetch_logs_in_range(blocks).await?, watermark, false))
        }
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
                event.tx_index,
                event.log_index,
                stream,
                sequence,
                id,
            )
        });
    }

    async fn header_at(&self, height: u64) -> hyperlane_core::ChainResult<Header> {
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
}

#[async_trait]
impl Source for GenericSource {
    async fn header(&self, selector: BlockSelector) -> Result<Header> {
        let height = match selector {
            BlockSelector::Height(height) => height,
            BlockSelector::Latest => {
                self.provider
                    .get_chain_metrics()
                    .await?
                    .ok_or_else(|| eyre!("Provider omitted chain height"))?
                    .block_height
            }
            BlockSelector::Safe | BlockSelector::Finalized => {
                u64::from(self.messages.latest_sequence_count_and_tip().await?.1)
            }
        };
        Ok(self.header_at(height).await?)
    }

    async fn range_end(&self, after: u64, through: u64, head: u64) -> Result<Header> {
        ensure!(after < through, "Empty indexing range");
        ensure!(through <= head, "Range boundary is ahead of head");
        let mut first_error = None;
        for height in (after.saturating_add(1)..=through).rev() {
            match self.header_at(height).await {
                Ok(header) => return Ok(header),
                Err(error) if self.provider.is_block_not_found_error(&error) => {
                    first_error.get_or_insert(eyre::Report::new(error));
                }
                Err(error) => return Err(error.into()),
            }
        }
        // An entire chunk may consist of skipped slots. Advance to the first
        // real block after it without treating nonexistent slots as headers.
        let limit = head.min(through.saturating_add(through.saturating_sub(after)));
        for height in through.saturating_add(1)..=limit {
            match self.header_at(height).await {
                Ok(header) => return Ok(header),
                Err(error) if self.provider.is_block_not_found_error(&error) => {
                    first_error.get_or_insert(eyre::Report::new(error));
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(first_error.unwrap_or_else(|| eyre!("No canonical block in indexing range")))
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

    async fn publication_tip(&self) -> Result<Option<u64>> {
        let (messages, deliveries, payments) = tokio::try_join!(
            self.messages.latest_sequence_count_and_tip(),
            self.deliveries.latest_sequence_count_and_tip(),
            self.payments.latest_sequence_count_and_tip(),
        )?;
        let insertion_tip = if self.derive_insertions_from_messages {
            messages.1
        } else {
            self.insertions.latest_sequence_count_and_tip().await?.1
        };
        Ok(Some(u64::from(
            [messages.1, deliveries.1, payments.1, insertion_tip]
                .into_iter()
                .min()
                .ok_or_else(|| eyre!("Missing event-stream tip"))?,
        )))
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
        let (messages, deliveries, payments, insertions) = tokio::try_join!(
            Self::logs(
                self.messages.as_ref(),
                range.clone(),
                sequences[0],
                self.sequence_mode,
                self.chunk_size,
            ),
            Self::logs(
                self.deliveries.as_ref(),
                range.clone(),
                sequences[1],
                self.sequence_mode,
                self.chunk_size,
            ),
            Self::logs(
                self.payments.as_ref(),
                range.clone(),
                sequences[2],
                self.sequence_mode,
                self.chunk_size,
            ),
            async {
                if self.derive_insertions_from_messages {
                    Ok((Vec::new(), (None, 0), false))
                } else {
                    Self::logs(
                        self.insertions.as_ref(),
                        range,
                        sequences[3],
                        self.sequence_mode,
                        self.chunk_size,
                    )
                    .await
                }
            },
        )?;
        let (messages, message_watermark, messages_complete) = messages;
        let (deliveries, delivery_watermark, deliveries_complete) = deliveries;
        let (payments, payment_watermark, payments_complete) = payments;
        let (insertions, mut insertion_watermark, mut insertions_complete) = insertions;
        if self.derive_insertions_from_messages {
            insertion_watermark = message_watermark;
            insertions_complete = messages_complete;
        }
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
        ensure!(
            events.iter().all(|event| event.block_number >= from),
            "Indexer returned an event from a different block"
        );
        // Sequence tips can advance after the observed head. Defer those events
        // until their blocks are included in a later observation.
        events.retain(|event| event.block_number <= through);
        Ok(EventBatch {
            events,
            watermarks: Some([
                message_watermark,
                delivery_watermark,
                payment_watermark,
                insertion_watermark,
            ]),
            complete_through: Some([
                messages_complete,
                deliveries_complete,
                payments_complete,
                insertions_complete,
            ]),
        })
    }
}

#[cfg(test)]
mod tests {
    use std::{ops::RangeInclusive, sync::Mutex};

    use ethers::{
        abi::{encode, Token},
        providers::Provider,
    };

    use super::*;

    #[derive(Debug)]
    struct SequenceIndexer {
        count: u32,
        tip: u32,
        truncate_last: bool,
        requests: Mutex<Vec<RangeInclusive<u32>>>,
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
        assert!(
            GenericSource::logs(&indexer, 100..=200, 7, true, 2)
                .await?
                .2
        );
        assert_eq!(
            *indexer.requests.lock().expect("request mutex poisoned"),
            vec![7..=8, 9..=9]
        );

        indexer
            .requests
            .lock()
            .expect("request mutex poisoned")
            .clear();
        assert!(
            !GenericSource::logs(&indexer, 100..=200, 7, false, 2)
                .await?
                .2
        );
        assert_eq!(
            *indexer.requests.lock().expect("request mutex poisoned"),
            vec![100..=200]
        );
        assert!(GenericSource::logs(&indexer, 100..=200, 11, true, 2)
            .await
            .is_err());

        let partial = SequenceIndexer {
            count: 10,
            tip: 200,
            truncate_last: true,
            requests: Mutex::new(Vec::new()),
        };
        assert!(GenericSource::logs(&partial, 100..=200, 7, true, 10)
            .await
            .is_err());

        let bounded = SequenceIndexer {
            count: 100,
            tip: 200,
            truncate_last: false,
            requests: Mutex::new(Vec::new()),
        };
        GenericSource::logs(&bounded, 0..=3, 0, true, 2).await?;
        assert_eq!(
            *bounded.requests.lock().expect("request mutex poisoned"),
            vec![0..=1, 2..=3, 4..=5]
        );
        let lagging = SequenceIndexer {
            count: 10,
            tip: 199,
            truncate_last: false,
            requests: Mutex::new(Vec::new()),
        };
        assert!(GenericSource::logs(&lagging, 100..=200, 7, true, 2)
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
        rpc.push::<Vec<Log>, _>(vec![log.clone(), log])?;
        assert!(source
            .events(header.height, header.height + 100)
            .await
            .is_err());
        Ok(())
    }
}
