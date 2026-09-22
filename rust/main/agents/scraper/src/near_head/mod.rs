//! Store EVM logs once, at the head; expose them to legacy readers after confirmation.
mod enrichment;
mod runtime;
mod source;
mod store;

use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};

use ethers::types::{BlockNumber, H160};
use eyre::{ensure, Result};
use futures::{stream, StreamExt, TryStreamExt};
use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf},
    ChainMetrics, ContractSyncMetrics, CoreMetrics,
};
use hyperlane_core::{ContractLocator, ReorgPeriod};
use serde::Deserialize;
use tokio::task::JoinHandle;

use crate::store::HyperlaneDbStore;
use source::{Contracts, Header, Source, SourceBuilder};
use store::{State, Store};

/// Opt-in chains. Other protocols and chains keep their existing indexers.
pub type Configs = HashMap<u32, Config>;

/// Explicit completed legacy boundary; no historical rows are reinterpreted.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    /// First new block to index; all four legacy streams must be complete before it.
    #[serde(alias = "fromblock", deserialize_with = "config_u32")]
    pub from_block: u32,
}

fn config_u32<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u32, D::Error> {
    hyperlane_core::config::StrOrInt::deserialize(deserializer)?
        .try_into()
        .map_err(serde::de::Error::custom)
}

/// Prevent accidental fallback to legacy writers while provisional state exists.
pub async fn ensure_legacy_mode(legacy: &HyperlaneDbStore) -> Result<()> {
    let store = Store {
        db: legacy.db.clone_connection(),
        domain: legacy.domain.id(),
    };
    ensure!(store.state().await?.is_none(), "nearHead was disabled with retained state; drain and clear scraper_head before restarting legacy indexers");
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

/// Replace the four EVM log indexers with one range ingestion worker.
pub async fn spawn(
    conf: &ChainConf,
    config: &Config,
    legacy: HyperlaneDbStore,
    metrics: Arc<CoreMetrics>,
    chain_metrics: ChainMetrics,
    sync_metrics: Arc<ContractSyncMetrics>,
    receipt_age: prometheus::GaugeVec,
) -> Result<JoinHandle<()>> {
    let ChainConnectionConf::Ethereum(connection) = &conf.connection else {
        eyre::bail!("nearHead requires an EVM chain");
    };
    let contracts = Contracts {
        mailbox: H160::from(conf.addresses.mailbox),
        hook: H160::from(conf.addresses.merkle_tree_hook),
        paymaster: H160::from(conf.addresses.interchain_gas_paymaster),
    };
    let source = conf
        .build_ethereum(
            connection,
            &ContractLocator {
                domain: &conf.domain,
                address: conf.addresses.mailbox,
            },
            &metrics,
            SourceBuilder {
                contracts: contracts.clone(),
                domain: conf.domain.id(),
            },
        )
        .await?;
    let store = Store {
        db: legacy.db.clone_connection(),
        domain: conf.domain.id(),
    };
    let anchor_height = config
        .from_block
        .checked_sub(1)
        .ok_or_else(|| eyre::eyre!("nearHead fromBlock must be positive"))?;
    store.pause(false).await?;
    let anchor = source.header(u64::from(anchor_height).into()).await?;
    let period = conf.reorg_period.clone();
    ensure!(conf.index.chunk_size > 0, "index.chunk must be positive");
    let chunk_size = u64::from(conf.index.chunk_size);
    // Match the legacy range cursor's near-tip refresh cadence.
    let poll_interval = conf
        .index
        .configured_interval
        .unwrap_or(Duration::from_secs(30));
    prepare(source.as_ref(), &store, &anchor, &contracts, &period).await?;
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

async fn prepare(
    source: &dyn Source,
    store: &Store,
    anchor: &Header,
    contracts: &Contracts,
    period: &ReorgPeriod,
) -> Result<()> {
    // Fail before persisting a first-time cutover if required RPC methods fail.
    if let ReorgPeriod::Tag(tag) = period {
        ensure!(
            matches!(tag.as_str(), "safe" | "finalized" | "latest"),
            "Unsupported reorgPeriod tag"
        );
        source
            .header(tag.parse().map_err(eyre::Report::msg)?)
            .await?;
    }
    // Check the actual retained boundary on restart, not historical cutover state.
    let hash = match store.state().await? {
        // The retained hash may be orphaned; probe the current fork and let observe
        // reconcile retained history after startup.
        Some(state) => source.header(state.indexed.into()).await?.hash,
        None => anchor.hash,
    };
    source.counts(hash).await?;
    store.initialize(anchor, contracts).await?;
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
    let head = source.header(BlockNumber::Latest).await?;
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
            source.header(height.into()).await?
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

async fn ingest_cached(
    source: &dyn Source,
    store: &Store,
    state: &State,
    chunk_size: u64,
    count_cache: &mut Option<(ethers::types::H256, [u32; 2])>,
) -> Result<bool> {
    ensure!(chunk_size > 0, "Empty indexing range");
    if state.indexed == state.head {
        return Ok(false);
    }
    let end = state.head.min(state.indexed.saturating_add(chunk_size));
    let boundary = source.header(end.into()).await?;
    let mut by_block = BTreeMap::<u64, Vec<source::Event>>::new();
    let cached = count_cache.filter(|(hash, _)| *hash == state.hash);
    let start_counts = async {
        match cached {
            Some((_, counts)) => Ok(counts),
            None => source.counts(state.hash).await,
        }
    };
    let (events, start_counts, end_counts) = tokio::try_join!(
        source.events(state.indexed.saturating_add(1), end),
        start_counts,
        source.counts(boundary.hash),
    )?;
    validate_sequences(&events, start_counts, end_counts)?;
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
        .map(|(height, events)| {
            let boundary = &boundary;
            async move {
                let header = if height == end {
                    boundary.clone()
                } else {
                    source.header(height.into()).await?
                };
                ensure!(
                    events.iter().all(|event| event.block_hash == header.hash),
                    "Range contains logs from another fork"
                );
                Ok::<_, eyre::Report>((header, events))
            }
        })
        .buffered(8)
        .try_collect()
        .await?;
    ensure!(
        source.header(state.indexed.into()).await?.hash == state.hash,
        "Indexed boundary changed during range fetch"
    );
    verify(source, &boundary).await?;
    store.append(state, &blocks).await?;
    *count_cache = Some((boundary.hash, end_counts));
    Ok(end < state.head)
}

fn validate_sequences(events: &[source::Event], mut next: [u32; 2], end: [u32; 2]) -> Result<()> {
    for event in events {
        let (stream, index) = match &event.data {
            source::EventData::Dispatch(message) => (0, message.nonce),
            source::EventData::Insertion { index, .. } => (1, *index),
            _ => continue,
        };
        ensure!(index == next[stream], "Missing or unordered event sequence");
        next[stream] = index
            .checked_add(1)
            .ok_or_else(|| eyre::eyre!("Event sequence overflow"))?;
    }
    ensure!(next == end, "Incomplete event range");
    Ok(())
}

async fn verify(source: &dyn Source, header: &Header) -> Result<()> {
    ensure!(
        source.header(header.height.into()).await?.hash == header.hash,
        "Chain changed during RPC reads"
    );
    Ok(())
}

async fn confirm(source: &dyn Source, store: &Store, period: &ReorgPeriod) -> Result<[u64; 4]> {
    let state = store
        .state()
        .await?
        .ok_or_else(|| eyre::eyre!("Missing head state"))?;
    ensure!(!state.halted, "Confirmed history requires operator repair");
    if state.indexed == state.confirmed {
        return Ok([0; 4]);
    }
    let tagged = match period {
        ReorgPeriod::Tag(tag) if tag != "latest" => Some(
            source
                .header(tag.parse().map_err(eyre::Report::msg)?)
                .await?,
        ),
        _ => None,
    };
    let through = match period {
        ReorgPeriod::Blocks(depth) => state.head.saturating_sub(u64::from(depth.get())),
        _ => tagged
            .as_ref()
            .map(|header| header.height)
            .unwrap_or(state.head),
    };
    ensure!(
        through <= state.head,
        "Confirmation tag is ahead of the observed head"
    );
    if through <= state.confirmed {
        return Ok([0; 4]);
    }
    let through = store
        .confirmation_boundary(state.confirmed, through.min(state.indexed))
        .await?;
    if through <= state.confirmed {
        return Ok([0; 4]);
    }
    let boundary = match tagged {
        Some(header) if header.height == through => header,
        _ => source.header(through.into()).await?,
    };
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
        source.header(state.indexed.into()).await?.hash
    };
    ensure!(
        indexed_hash == state.hash,
        "Indexed fork changed before confirmation"
    );
    store.confirm(&state, &boundary).await
}

#[cfg(test)]
use enrichment::enrich_with_timeout;

#[cfg(test)]
mod tests;
