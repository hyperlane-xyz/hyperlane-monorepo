//! Observe canonical history, ingest complete event ranges, then publish confirmed history.
use std::{collections::BTreeMap, time::Duration};

use eyre::{ensure, Result};
use futures::{stream, StreamExt, TryStreamExt};
use hyperlane_core::ReorgPeriod;
use tracing::warn;

use super::{
    source::{self, BlockSelector, Header, Source},
    store::{State, Store},
};

pub(super) async fn observe(source: &dyn Source, store: &Store) -> Result<State> {
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct CountCache {
    pub(super) boundary: Option<(ethers::types::H256, [u32; 4])>,
    /// Highest indexed height through which stored dispatches and insertions
    /// matched hash-pinned contract counts in this process. Counts are
    /// cumulative, so a match proves every earlier range complete, including
    /// ranges appended while counts were unavailable.
    pub(super) proven_through: Option<u64>,
}

pub(super) async fn ingest_cached(
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
    let available_head = source
        .indexing_tip()
        .await?
        .unwrap_or(state.head)
        .min(state.head);
    if available_head <= state.indexed {
        return Ok(false);
    }
    let start_counts = match count_cache
        .boundary
        .as_ref()
        .filter(|(hash, _)| *hash == state.hash)
    {
        Some((_, counts)) => *counts,
        None => {
            let counts = store.sequence_counts().await?;
            count_cache.boundary = Some((state.hash, counts));
            counts
        }
    };
    let requested_end = if source.indexes_by_sequence() {
        // Sequence paging is already bounded by its configured page size. Use
        // the observed head as the block boundary so sparse-slot chains do not
        // turn a sequence page into thousands of one-slot ingestion cycles.
        available_head
    } else {
        available_head.min(state.indexed.saturating_add(chunk_size))
    };
    if source.has_events_after(start_counts).await? == Some(false) {
        let boundary = source
            .range_end(state.indexed, requested_end, available_head)
            .await?;
        ensure!(
            source
                .fresh_header(BlockSelector::Height(state.indexed))
                .await?
                .hash
                == state.hash,
            "Indexed boundary changed during range fetch"
        );
        verify(source, &boundary).await?;
        store.append(state, &[(boundary.clone(), vec![])]).await?;
        count_cache.boundary = Some((boundary.hash, start_counts));
        return Ok(boundary.height < state.head);
    }
    let mut boundary = source
        .range_end(state.indexed, requested_end, available_head)
        .await?;
    let mut end = boundary.height;
    let mut by_block = BTreeMap::<u64, Vec<source::Event>>::new();
    // Retain exact range validation where historical state is available, but do
    // not let a pruned-state RPC prevent catch-up from durable sequence counts.
    let end_counts = async {
        match source.counts(boundary.hash).await {
            Ok(counts) => Ok::<_, eyre::Report>(counts),
            Err(error) => {
                warn!(
                    domain = store.domain,
                    height = boundary.height,
                    ?error,
                    "Historical sequence counts unavailable; using durable continuity"
                );
                Ok(None)
            }
        }
    };
    let (batch, end_counts) = tokio::try_join!(
        source.events_after(state.indexed.saturating_add(1), end, start_counts),
        end_counts,
    )?;
    if end_counts.is_none()
        && batch
            .events
            .iter()
            .any(|event| event.block_number <= state.confirmed)
    {
        eyre::bail!("Event range crossed confirmed history");
    }
    ensure!(
        batch.through > state.indexed,
        "Event batch made no block progress"
    );
    if batch.through < end {
        boundary = source
            .range_end(state.indexed, batch.through, available_head)
            .await?;
        end = boundary.height;
    }
    let events = batch.events;
    let validated_counts = match advance_sequences(&events, start_counts) {
        Ok(counts) => counts,
        Err(error) => {
            if state.indexed > state.confirmed {
                store.rewind_to_confirmed(state).await?;
            }
            count_cache.boundary = None;
            return Err(error);
        }
    };
    if let Some(end_counts) = end_counts {
        if validated_counts[0] != end_counts[0] || validated_counts[3] != end_counts[1] {
            // With an unproven provisional suffix the missing events may be in an
            // earlier range; replay it instead of failing the same way forever.
            // Otherwise everything before this range is proven and a retry suffices.
            let unproven = count_cache.proven_through.unwrap_or(state.confirmed) < state.indexed;
            if unproven && state.indexed > state.confirmed {
                store.rewind_to_confirmed(state).await?;
                count_cache.boundary = None;
            }
            eyre::bail!("Incomplete event range");
        }
    }
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
            .fresh_header(BlockSelector::Height(state.indexed))
            .await?
            .hash
            == state.hash,
        "Indexed boundary changed during range fetch"
    );
    verify(source, &boundary).await?;
    store.append(state, &blocks).await?;
    count_cache.boundary = Some((boundary.hash, validated_counts));
    if end_counts.is_some() {
        count_cache.proven_through = Some(end);
    }
    Ok(end < state.head)
}

pub(super) fn advance_sequences(events: &[source::Event], mut next: [u32; 4]) -> Result<[u32; 4]> {
    const STREAMS: [&str; 4] = ["dispatch", "delivery", "gas payment", "insertion"];
    for event in events {
        let (stream, index) = match &event.data {
            source::EventData::Dispatch(message) => (0, Some(message.nonce)),
            source::EventData::Delivery(_) => (1, event.sequence),
            source::EventData::Gas { .. } => (2, event.sequence),
            source::EventData::Insertion { index, .. } => (3, Some(*index)),
        };
        let Some(index) = index else { continue };
        ensure!(
            index == next[stream],
            "Missing or unordered {} sequence: expected {}, received {}",
            STREAMS[stream],
            next[stream],
            index
        );
        next[stream] = index
            .checked_add(1)
            .ok_or_else(|| eyre::eyre!("Event sequence overflow"))?;
    }
    Ok(next)
}

async fn verify(source: &dyn Source, header: &Header) -> Result<()> {
    ensure!(
        source
            .fresh_header(BlockSelector::Height(header.height))
            .await?
            .hash
            == header.hash,
        "Chain changed during RPC reads"
    );
    Ok(())
}

/// Shortest lease on a head observation that confirmation will accept.
pub(super) const MIN_CONFIRMATION_LEASE: Duration = Duration::from_secs(60);

/// Confirmation needs a recent healthy observation: pauses clear `healthy`, so a
/// lagging or reorging RPC stops publication. It does not need
/// a fresh one: confirmation rechecks ancestry against the RPC before
/// committing, and an older head only lowers the depth/tag boundary. The lease
/// therefore spans one poll plus database latency rather than equalling it.
pub(super) fn confirmation_lease(poll_interval: Duration) -> Duration {
    poll_interval.saturating_mul(2).max(MIN_CONFIRMATION_LEASE)
}

#[derive(Default)]
pub(super) struct Confirmation {
    pub(super) counts: [u64; 4],
    pub(super) page_limited: bool,
}

pub(super) async fn confirm_leased_through(
    source: &dyn Source,
    store: &Store,
    period: &ReorgPeriod,
    lease: Duration,
    publishable: u64,
) -> Result<Confirmation> {
    let state = store
        .state()
        .await?
        .ok_or_else(|| eyre::eyre!("Missing head state"))?;
    ensure!(!state.halted, "Confirmed history requires operator repair");
    if state.indexed == state.confirmed || publishable <= state.confirmed {
        return Ok(Confirmation::default());
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
    let through = through.min(state.head);
    if through <= state.confirmed {
        return Ok(Confirmation::default());
    }
    let target = through.min(state.indexed).min(publishable);
    let through = store.confirmation_boundary(state.confirmed, target).await?;
    if through <= state.confirmed {
        return Ok(Confirmation::default());
    }
    let checkpoint = store.checkpoint_between(state.confirmed, through).await?;
    let boundary = match tagged {
        Some(header) if header.height == through => header,
        _ => {
            let after = checkpoint.map_or(state.confirmed, |height| height.saturating_sub(1));
            source.fresh_range_end(after, through, through).await?
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
    let indexed_hash = source
        .fresh_header(BlockSelector::Height(state.indexed))
        .await?
        .hash;
    ensure!(
        indexed_hash == state.hash,
        "Indexed fork changed before confirmation"
    );
    Ok(Confirmation {
        counts: store.confirm(&state, &boundary, lease).await?,
        page_limited: through < target,
    })
}

pub(super) fn tag_selector(tag: &str) -> Result<BlockSelector> {
    match tag {
        "latest" => Ok(BlockSelector::Latest),
        "safe" => Ok(BlockSelector::Safe),
        "finalized" => Ok(BlockSelector::Finalized),
        _ => eyre::bail!("Unsupported reorgPeriod tag"),
    }
}
