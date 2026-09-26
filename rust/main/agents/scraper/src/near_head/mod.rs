//! Store chain events once, at the head; expose them to legacy readers after confirmation.
mod enrichment;
mod runtime;
mod source;
mod store;

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use eyre::{ensure, Result};
use futures::{stream, StreamExt, TryStreamExt};
use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf},
    ChainMetrics, ContractSyncMetrics, CoreMetrics,
};
use hyperlane_core::{ContractLocator, ReorgPeriod};
use tokio::task::JoinHandle;

use crate::store::HyperlaneDbStore;
use source::{
    BlockSelector, Contracts, EvmContracts, GenericSource, Header, Source, SourceBuilder,
};
use store::{State, Store};

/// Prevent accidental fallback to legacy writers while provisional state exists.
pub async fn ensure_legacy_mode(legacy: &HyperlaneDbStore) -> Result<()> {
    let store = Store {
        db: legacy.db.clone_connection(),
        domain: legacy.domain.id(),
    };
    ensure!(store.state().await?.is_none(), "Cannot use legacy indexers with retained near-head state; drain and clear scraper_head before switching protocols");
    Ok(())
}

/// Keep auxiliary writers out of the provisional suffix, including after a halt.
pub async fn confirmed_height(db: &crate::db::ScraperDb, domain: u32) -> Result<u32> {
    let state = Store {
        db: db.clone_connection(),
        domain,
    }
    .state()
    .await?
    .ok_or_else(|| eyre::eyre!("Missing near-head progress"))?;
    ensure!(!state.halted, "Confirmed history requires operator repair");
    Ok(u32::try_from(state.confirmed)?)
}

/// Replace the four log indexers with one range ingestion worker.
pub async fn spawn(
    conf: &ChainConf,
    legacy: HyperlaneDbStore,
    metrics: Arc<CoreMetrics>,
    chain_metrics: ChainMetrics,
    sync_metrics: Arc<ContractSyncMetrics>,
    receipt_age: prometheus::GaugeVec,
) -> Result<JoinHandle<()>> {
    let contracts = Contracts {
        mailbox: conf.addresses.mailbox,
        hook: conf.addresses.merkle_tree_hook,
        paymaster: conf.addresses.interchain_gas_paymaster,
    };
    let source: Box<dyn Source> =
        if let ChainConnectionConf::Ethereum(connection) = &conf.connection {
            conf.build_ethereum(
                connection,
                &ContractLocator {
                    domain: &conf.domain,
                    address: conf.addresses.mailbox,
                },
                &metrics,
                SourceBuilder {
                    contracts: EvmContracts {
                        mailbox: conf.addresses.mailbox.into(),
                        hook: conf.addresses.merkle_tree_hook.into(),
                        paymaster: conf.addresses.interchain_gas_paymaster.into(),
                    },
                    domain: conf.domain.id(),
                },
            )
            .await?
        } else {
            GenericSource::build(conf, &metrics, contracts.clone()).await?
        };
    let store = Store {
        db: legacy.db.clone_connection(),
        domain: conf.domain.id(),
    };
    let initialized = store.state().await?.is_some();
    ensure!(
        source.has_historical_counts() || initialized,
        "Non-EVM near-head indexing requires an explicit verified scraper_head cutover"
    );
    let anchor = if initialized {
        None
    } else {
        let anchor_height = store.anchor_height(u32::try_from(conf.index.from)?).await?;
        Some(source.header(BlockSelector::Height(anchor_height)).await?)
    };
    let period = conf.reorg_period.clone();
    ensure!(conf.index.chunk_size > 0, "index.chunk must be positive");
    let chunk_size = u64::from(conf.index.chunk_size);
    // Match the legacy range cursor's near-tip refresh cadence.
    let poll_interval = conf
        .index
        .configured_interval
        .unwrap_or(Duration::from_secs(30));
    prepare(
        source.as_ref(),
        &store,
        anchor.as_ref(),
        &contracts,
        &period,
    )
    .await?;
    let worker = runtime::Worker {
        source,
        store,
        domain: legacy.domain.clone(),
        period,
        chunk_size,
        poll_interval,
        chain_metrics,
        sync_metrics,
    };
    Ok(tokio::spawn(async move {
        tokio::join!(
            worker.run(),
            enrichment::run(&legacy, poll_interval, &receipt_age)
        );
    }))
}

async fn prepare<'a>(
    source: &dyn Source,
    store: &Store,
    anchor: impl Into<Option<&'a Header>>,
    contracts: &Contracts,
    period: &ReorgPeriod,
) -> Result<()> {
    let anchor = anchor.into();
    // Fail before persisting a first-time cutover if required RPC methods fail.
    if let ReorgPeriod::Tag(tag) = period {
        ensure!(
            matches!(tag.as_str(), "safe" | "finalized" | "latest"),
            "Unsupported reorgPeriod tag"
        );
        source.header(tag_selector(tag)?).await?;
    }
    // Capability checks must not require an RPC that is caught up to our saved
    // indexed height. The observation loop waits for lagging providers and
    // checks retained ancestry before publishing anything.
    let state = store.state().await?;
    let hash = match state {
        Some(_) => {
            store.validate_checkpoints().await?;
            store.validate_contracts(contracts).await?;
            source.header(BlockSelector::Latest).await?.hash
        }
        None => {
            anchor
                .ok_or_else(|| eyre::eyre!("Missing first-start anchor"))?
                .hash
        }
    };
    if source.has_historical_counts() {
        source.counts(hash).await?;
    }
    if let Some(anchor) = anchor {
        store.initialize(anchor, contracts).await?;
    }
    Ok(())
}

async fn observe(source: &dyn Source, store: &Store) -> Result<State> {
    let state = store
        .state()
        .await?
        .ok_or_else(|| eyre::eyre!("Missing head state"))?;
    ensure!(
        !state.halted,
        "Reorg crossed published history; operator repair required"
    );
    let head = source.header(BlockSelector::Latest).await?;
    if head.height < state.indexed {
        // A lagging RPC can report an older head without disproving our stored
        // chain. Pause until it catches up; only a hash mismatch proves a reorg.
        store.pause(false).await?;
        eyre::bail!("RPC head is behind indexed history; waiting for a current observation");
    }
    let mut height = store.checkpoint(state.indexed.min(head.height)).await?;
    let ancestor = loop {
        let header = if height == head.height {
            head.clone()
        } else {
            source.header(BlockSelector::Height(height)).await?
        };
        if store.hash(height).await? == Some(header.hash) {
            break header;
        }
        store.pause(height == state.confirmed).await?;
        ensure!(
            height > state.confirmed,
            "Reorg crossed published history; operator repair required"
        );
        height = store
            .checkpoint(
                height
                    .checked_sub(1)
                    .ok_or_else(|| eyre::eyre!("Missing common ancestor"))?,
            )
            .await?;
    };
    if ancestor.hash != head.hash {
        verify(source, &head).await?;
    }
    store.observe(&state, &ancestor, &head).await?;
    store
        .state()
        .await?
        .ok_or_else(|| eyre::eyre!("Missing observed state"))
}

#[cfg(test)]
async fn ingest(
    source: &dyn Source,
    store: &Store,
    state: &State,
    chunk_size: u64,
) -> Result<bool> {
    ingest_cached(source, store, state, chunk_size, &mut None).await
}

type CountCache = Option<(ethers::types::H256, [u32; 4])>;

async fn ingest_cached(
    source: &dyn Source,
    store: &Store,
    state: &State,
    chunk_size: u64,
    count_cache: &mut CountCache,
) -> Result<bool> {
    ensure!(chunk_size > 0, "Empty indexing range");
    if state.indexed == state.head {
        return Ok(false);
    }
    let requested_end = if source.indexes_by_sequence() {
        // Sequence paging is already bounded by its configured page size. Use
        // the observed head as the block boundary so sparse-slot chains do not
        // turn a sequence page into thousands of one-slot ingestion cycles.
        state.head
    } else {
        state.head.min(state.indexed.saturating_add(chunk_size))
    };
    let mut boundary = source
        .range_end(state.indexed, requested_end, state.head)
        .await?;
    let mut end = boundary.height;
    let mut by_block = BTreeMap::<u64, Vec<source::Event>>::new();
    let cached = count_cache.as_ref().filter(|(hash, _)| *hash == state.hash);
    let start_counts = async {
        match cached {
            Some((_, counts)) => Ok::<_, eyre::Report>(*counts),
            None if source.has_historical_counts() => {
                let exact = source.counts(state.hash).await?;
                Ok([exact[0], 0, 0, exact[1]])
            }
            None => Ok(store.sequence_counts().await?),
        }
    };
    let end_counts = async {
        if source.has_historical_counts() {
            Ok(Some(source.counts(boundary.hash).await?))
        } else {
            Ok(None)
        }
    };
    let (events, end_counts) = tokio::try_join!(
        async {
            let counts = start_counts.await?;
            Ok::<_, eyre::Report>((
                source
                    .events_after(state.indexed.saturating_add(1), end, counts)
                    .await?,
                counts,
            ))
        },
        end_counts,
    )?;
    let (batch, start_counts) = events;
    if source.indexes_by_sequence()
        && batch
            .events
            .iter()
            .any(|event| event.block_number <= state.indexed)
    {
        store.rewind_to_confirmed(state).await?;
        eyre::bail!("Sequence gap crossed the provisional frontier; rewound for retry");
    }
    if let Some(indexed_through) = batch.indexed_through {
        ensure!(
            indexed_through > state.indexed,
            "Sequence page made no block progress"
        );
        if indexed_through < end {
            boundary = source
                .range_end(state.indexed, indexed_through, state.head)
                .await?;
            end = boundary.height;
        }
    }
    let events = batch.events;
    let validated_counts = advance_sequences(&events, start_counts)?;
    if let Some(end_counts) = end_counts {
        ensure!(
            validated_counts[0] == end_counts[0] && validated_counts[3] == end_counts[1],
            "Incomplete event range"
        );
    }
    let counts_at_tips = counts_at_watermarks(&events, start_counts, batch.watermarks);
    let verified_through = batch
        .watermarks
        .zip(batch.complete_through)
        .map(|(watermarks, complete_through)| {
            validate_watermarks(
                counts_at_tips,
                boundary.height,
                watermarks,
                complete_through,
            )
        })
        .transpose()?
        .flatten();
    for event in events {
        ensure!(
            event.block_number > state.indexed && event.block_number <= end,
            "Event outside requested range"
        );
        by_block.entry(event.block_number).or_default().push(event);
    }
    // Empty ranges still advance, using only their end header as a checkpoint.
    by_block.entry(end).or_default();
    let blocks: Vec<_> = stream::iter(by_block)
        .map(|(height, mut events)| {
            let boundary = &boundary;
            async move {
                let header = if height == end {
                    boundary.clone()
                } else {
                    source.header(BlockSelector::Height(height)).await?
                };
                ensure!(
                    events
                        .iter()
                        .all(|event| event.block_hash.is_zero() || event.block_hash == header.hash),
                    "Range contains logs from another fork"
                );
                for event in &mut events {
                    event.block_hash = header.hash;
                }
                Ok::<_, eyre::Report>((header, events))
            }
        })
        .buffered(8)
        .try_collect()
        .await?;
    ensure!(
        source
            .header(BlockSelector::Height(state.indexed))
            .await?
            .hash
            == state.hash,
        "Indexed boundary changed during range fetch"
    );
    verify(source, &boundary).await?;
    store.append(state, &blocks, verified_through).await?;
    *count_cache = Some((boundary.hash, validated_counts));
    Ok(end < state.head)
}

fn validate_watermarks(
    counts: [u32; 4],
    indexed_height: u64,
    watermarks: [(Option<u32>, u32); 4],
    complete_through: [bool; 4],
) -> Result<Option<u64>> {
    let mut verified_through = indexed_height;
    for (stream, (expected, tip)) in watermarks.into_iter().enumerate() {
        if u64::from(tip) > indexed_height {
            if expected.is_some() && !complete_through[stream] {
                return Ok(None);
            }
            continue;
        }
        let Some(expected) = expected else {
            verified_through = verified_through.min(u64::from(tip));
            continue;
        };
        ensure!(
            counts[stream] == expected,
            "Incomplete finalized event sequence"
        );
        verified_through = verified_through.min(u64::from(tip));
    }
    Ok(Some(verified_through))
}

fn counts_at_watermarks(
    events: &[source::Event],
    start: [u32; 4],
    watermarks: Option<[(Option<u32>, u32); 4]>,
) -> [u32; 4] {
    let Some(watermarks) = watermarks else {
        return start;
    };
    let mut counts = start;
    for event in events {
        let (stream, sequence) = match &event.data {
            source::EventData::Dispatch(message) => (0, Some(message.nonce)),
            source::EventData::Delivery(_) => (1, event.sequence),
            source::EventData::Gas { .. } => (2, event.sequence),
            source::EventData::Insertion { index, .. } => (3, Some(*index)),
        };
        if event.block_number <= u64::from(watermarks[stream].1) && sequence.is_some() {
            counts[stream] = counts[stream].saturating_add(1);
        }
    }
    counts
}

#[cfg(test)]
fn validate_sequences(events: &[source::Event], next: [u32; 2], end: [u32; 2]) -> Result<()> {
    let next = advance_sequences(events, [next[0], 0, 0, next[1]])?;
    ensure!([next[0], next[3]] == end, "Incomplete event range");
    Ok(())
}

fn advance_sequences(events: &[source::Event], mut next: [u32; 4]) -> Result<[u32; 4]> {
    for event in events {
        let (stream, index) = match &event.data {
            source::EventData::Dispatch(message) => (0, Some(message.nonce)),
            source::EventData::Delivery(_) => (1, event.sequence),
            source::EventData::Gas { .. } => (2, event.sequence),
            source::EventData::Insertion { index, .. } => (3, Some(*index)),
        };
        let Some(index) = index else { continue };
        ensure!(index == next[stream], "Missing or unordered event sequence");
        next[stream] = index
            .checked_add(1)
            .ok_or_else(|| eyre::eyre!("Event sequence overflow"))?;
    }
    Ok(next)
}

async fn verify(source: &dyn Source, header: &Header) -> Result<()> {
    ensure!(
        source
            .header(BlockSelector::Height(header.height))
            .await?
            .hash
            == header.hash,
        "Chain changed during RPC reads"
    );
    Ok(())
}

/// Shortest lease on a head observation that confirmation will accept.
const MIN_CONFIRMATION_LEASE: Duration = Duration::from_secs(60);

/// Confirmation needs a recent healthy observation: pauses clear `healthy`, so a
/// lagging or reorging RPC stops publication. It does not need
/// a fresh one: confirmation rechecks ancestry against the RPC before
/// committing, and an older head only lowers the depth/tag boundary. The lease
/// therefore spans one poll plus database latency rather than equalling it.
fn confirmation_lease(poll_interval: Duration) -> Duration {
    poll_interval.saturating_mul(2).max(MIN_CONFIRMATION_LEASE)
}

#[cfg(test)]
async fn confirm(source: &dyn Source, store: &Store, period: &ReorgPeriod) -> Result<[u64; 4]> {
    Ok(
        confirm_leased(source, store, period, MIN_CONFIRMATION_LEASE, None)
            .await?
            .counts,
    )
}

struct Confirmation {
    counts: [u64; 4],
    page_limited: bool,
}

async fn confirm_leased(
    source: &dyn Source,
    store: &Store,
    period: &ReorgPeriod,
    lease: Duration,
    publication_cap: Option<u64>,
) -> Result<Confirmation> {
    let state = store
        .state()
        .await?
        .ok_or_else(|| eyre::eyre!("Missing head state"))?;
    ensure!(!state.halted, "Confirmed history requires operator repair");
    if state.indexed == state.confirmed {
        return Ok(Confirmation {
            counts: [0; 4],
            page_limited: false,
        });
    }
    let tagged = match period {
        ReorgPeriod::Tag(tag) if tag != "latest" => Some(source.header(tag_selector(tag)?).await?),
        _ => None,
    };
    let through = match period {
        ReorgPeriod::Blocks(depth) => state.head.saturating_sub(u64::from(depth.get())),
        _ => tagged
            .as_ref()
            .map(|header| header.height)
            .unwrap_or(state.head),
    };
    // A tag read after the head observation can be newer than it. Everything up
    // to the observed head is then final; confirm only that observed history.
    let through = through
        .min(state.head)
        .min(publication_cap.unwrap_or(u64::MAX));
    if through <= state.confirmed {
        return Ok(Confirmation {
            counts: [0; 4],
            page_limited: false,
        });
    }
    let target = through.min(state.indexed);
    let through = store.confirmation_boundary(state.confirmed, target).await?;
    if through <= state.confirmed {
        return Ok(Confirmation {
            counts: [0; 4],
            page_limited: false,
        });
    }
    let checkpoint = store.checkpoint_between(state.confirmed, through).await?;
    let boundary = match tagged {
        Some(header) if header.height == through => header,
        _ => {
            let after = checkpoint.unwrap_or(state.confirmed);
            if after == through {
                source.header(BlockSelector::Height(through)).await?
            } else {
                source.range_end(after, through, through).await?
            }
        }
    };
    let through = boundary.height;
    if let Some(hash) = store.hash(through).await? {
        ensure!(
            hash == boundary.hash,
            "Confirmation boundary is on another fork"
        );
    }
    // A sparse boundary must be checked against the indexed range's canonical tip.
    let indexed_hash = if through == state.indexed {
        boundary.hash
    } else {
        source
            .header(BlockSelector::Height(state.indexed))
            .await?
            .hash
    };
    ensure!(
        indexed_hash == state.hash,
        "Indexed fork changed before confirmation"
    );
    Ok(Confirmation {
        counts: store.confirm(&state, &boundary, lease).await?,
        page_limited: through < target,
    })
}

fn tag_selector(tag: &str) -> Result<BlockSelector> {
    match tag {
        "latest" => Ok(BlockSelector::Latest),
        "safe" => Ok(BlockSelector::Safe),
        "finalized" => Ok(BlockSelector::Finalized),
        _ => eyre::bail!("Unsupported reorgPeriod tag"),
    }
}

#[cfg(test)]
use enrichment::enrich_with_timeout;

#[cfg(test)]
mod tests;
