//! Adapts protocol indexers to complete block ranges, including sequence-based streams.
use super::{BlockSelector, Contracts, Event, EventBatch, EventData, Header, Source};
use async_trait::async_trait;
use ethers::types::H256 as EthersH256;
use eyre::{ensure, eyre, Result};
use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::{
    HyperlaneDomainProtocol, HyperlaneMessage, HyperlaneProvider, IndexMode, Indexed,
    InterchainGasPayment, LogMeta, MerkleTreeInsertion, SequenceAwareIndexer, H256,
};
use std::collections::{HashMap, HashSet};
use tokio::sync::RwLock;

type StreamTip = (Option<u32>, u32);
type StreamTips = [StreamTip; 4];

pub(in crate::near_head) struct GenericSource {
    provider: Box<dyn HyperlaneProvider>,
    messages: Box<dyn SequenceAwareIndexer<HyperlaneMessage>>,
    deliveries: Box<dyn SequenceAwareIndexer<H256>>,
    payments: Box<dyn SequenceAwareIndexer<InterchainGasPayment>>,
    insertions: Box<dyn SequenceAwareIndexer<MerkleTreeInsertion>>,
    contracts: Contracts,
    sequence_mode: bool,
    derive_insertions_from_messages: bool,
    chunk_size: u32,
    headers: RwLock<HashMap<u64, Header>>,
    streams: RwLock<Option<StreamTips>>,
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
            headers: RwLock::new(HashMap::new()),
            streams: RwLock::new(None),
        }))
    }

    async fn latest_streams(&self) -> Result<StreamTips> {
        if let Some(streams) = *self.streams.read().await {
            return Ok(streams);
        }
        let mut cached = self.streams.write().await;
        if let Some(streams) = *cached {
            return Ok(streams);
        }
        let insertion = async {
            if self.derive_insertions_from_messages {
                Ok(None)
            } else {
                Ok(Some(self.insertions.latest_sequence_count_and_tip().await?))
            }
        };
        let (messages, deliveries, payments, insertions) = tokio::try_join!(
            self.messages.latest_sequence_count_and_tip(),
            self.deliveries.latest_sequence_count_and_tip(),
            self.payments.latest_sequence_count_and_tip(),
            insertion,
        )?;
        let streams = [
            messages,
            deliveries,
            payments,
            insertions.unwrap_or(messages),
        ];
        *cached = Some(streams);
        Ok(streams)
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
        (count, tip): StreamTip,
        blocks: std::ops::RangeInclusive<u32>,
        next_sequence: u32,
        sequence_mode: bool,
        chunk_size: u32,
    ) -> Result<(Vec<(Indexed<T>, LogMeta)>, u32)> {
        ensure!(
            tip >= *blocks.end(),
            "Event-stream tip is behind the range boundary"
        );
        if !sequence_mode {
            return Ok((
                indexer.fetch_logs_in_range(blocks.clone()).await?,
                *blocks.end(),
            ));
        }
        let count = count.ok_or_else(|| eyre!("Indexer does not expose a sequence count"))?;
        ensure!(
            count >= next_sequence,
            "Provider sequence count is behind durable history"
        );
        if count == next_sequence {
            return Ok((Vec::new(), tip.min(*blocks.end())));
        }
        ensure!(chunk_size > 0, "index.chunk must be positive");
        let mut logs = Vec::new();
        let mut start = next_sequence;
        let mut previous_block = None;
        let mut first_block = None;
        let mut completed_through = None;
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
                completed_through = Some(*blocks.end());
                break;
            }
            if start == count {
                completed_through = Some(tip.min(*blocks.end()));
                break;
            }
            if Some(last_block) > first_block {
                completed_through = Some(last_block.saturating_sub(1).min(*blocks.end()));
                break;
            }
        }
        Ok((
            logs,
            completed_through.ok_or_else(|| eyre!("Sequence page made no progress"))?,
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
        // An entire chunk may consist of skipped slots. Advance to the first
        // real block after it without treating nonexistent slots as headers.
        let limit = head.min(through.saturating_add(through.saturating_sub(after)));
        let heights = (after.saturating_add(1)..=through)
            .rev()
            .chain(through.saturating_add(1)..=limit);
        let mut first_error = None;
        for height in heights {
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
        *self.streams.write().await = None;
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

    fn indexes_by_sequence(&self) -> bool {
        self.sequence_mode
    }

    async fn indexing_tip(&self) -> Result<Option<u64>> {
        let [messages, deliveries, payments, insertions] = self.latest_streams().await?;
        Ok([messages.1, deliveries.1, payments.1, insertions.1]
            .into_iter()
            .min()
            .map(u64::from))
    }

    async fn has_events_after(&self, sequences: [u32; 4]) -> Result<Option<bool>> {
        if !self.sequence_mode {
            return Ok(None);
        }
        let streams = self.latest_streams().await?;
        let mut has_events = false;
        for ((count, _), next) in streams.into_iter().zip(sequences) {
            let count = count.ok_or_else(|| eyre!("Indexer does not expose a sequence count"))?;
            ensure!(
                count >= next,
                "Provider sequence count is behind durable history"
            );
            has_events |= count > next;
        }
        Ok(Some(has_events))
    }

    async fn tip_sequence_counts(&self) -> Result<Option<[(Option<u32>, u32); 4]>> {
        if self.sequence_mode {
            return Ok(None);
        }
        let streams = self.latest_streams().await?;
        Ok(streams
            .iter()
            .any(|(count, _)| count.is_some())
            .then_some(streams))
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
        let [message_stream, delivery_stream, payment_stream, insertion_stream] =
            self.latest_streams().await?;
        let (messages, deliveries, payments, insertions) = tokio::try_join!(
            Self::logs(
                self.messages.as_ref(),
                message_stream,
                range.clone(),
                sequences[0],
                self.sequence_mode,
                self.chunk_size,
            ),
            Self::logs(
                self.deliveries.as_ref(),
                delivery_stream,
                range.clone(),
                sequences[1],
                self.sequence_mode,
                self.chunk_size,
            ),
            Self::logs(
                self.payments.as_ref(),
                payment_stream,
                range.clone(),
                sequences[2],
                self.sequence_mode,
                self.chunk_size,
            ),
            async {
                if self.derive_insertions_from_messages {
                    Ok((Vec::new(), u32::try_from(through)?))
                } else {
                    Self::logs(
                        self.insertions.as_ref(),
                        insertion_stream,
                        range,
                        sequences[3],
                        self.sequence_mode,
                        self.chunk_size,
                    )
                    .await
                }
            },
        )?;
        let (messages, message_through) = messages;
        let (deliveries, delivery_through) = deliveries;
        let (payments, payment_through) = payments;
        let (insertions, mut insertion_through) = insertions;
        if self.derive_insertions_from_messages {
            insertion_through = message_through;
        }
        let through = [
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
        events.retain(|event| event.block_number <= u64::from(through));
        Ok(EventBatch {
            events,
            through: u64::from(through),
        })
    }
}

#[cfg(test)]
mod tests;
