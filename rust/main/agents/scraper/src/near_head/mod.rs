//! Store EVM logs once, at the head; expose them to legacy readers after confirmation.
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
use tokio::{sync::Notify, task::JoinHandle, time::sleep};
use tracing::warn;

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

/// Replace the four EVM log indexers with one range ingestion worker.
pub async fn spawn(
    conf: &ChainConf,
    config: &Config,
    legacy: HyperlaneDbStore,
    metrics: Arc<CoreMetrics>,
    chain_metrics: ChainMetrics,
    sync_metrics: Arc<ContractSyncMetrics>,
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
    store.initialize(&anchor, &contracts).await?;
    let period = conf.reorg_period.clone();
    ensure!(conf.index.chunk_size > 0, "index.chunk must be positive");
    let chunk_size = u64::from(conf.index.chunk_size);
    // Match the legacy range cursor's near-tip refresh cadence.
    let poll_interval = conf
        .index
        .configured_interval
        .unwrap_or(Duration::from_secs(30));
    // Fail before spawning when the legacy policy is not supported by the RPC.
    if let ReorgPeriod::Tag(tag) = &period {
        ensure!(
            matches!(tag.as_str(), "safe" | "finalized" | "latest"),
            "Unsupported reorgPeriod tag"
        );
    }
    Ok(tokio::spawn(async move {
        let confirmation_wake = Notify::new();
        tokio::join!(
            async {
                loop {
                    let result = async {
                        let state = match observe(source.as_ref(), &store).await {
                            Ok(state) => state,
                            Err(error) => {
                                store.pause(false).await?;
                                return Err(error);
                            }
                        };
                        confirmation_wake.notify_one();
                        let more = ingest(source.as_ref(), &store, &state, chunk_size).await?;
                        confirmation_wake.notify_one();
                        Ok::<_, eyre::Report>(more)
                    }
                    .await;
                    chain_metrics.set_critical_error(legacy.domain.name(), result.is_err());
                    match result {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(error) => warn!(
                            domain = store.domain,
                            ?error,
                            "Near-head ingestion paused; retrying"
                        ),
                    }
                    sleep(poll_interval).await;
                }
            },
            async {
                let mut last_confirmed = 0;
                loop {
                    let result = async {
                        let counts = confirm(source.as_ref(), &store, &period).await?;
                        if let Some(state) = store.state().await? {
                            // Drain confirmation backlogs without waiting another poll interval.
                            if state.confirmed > last_confirmed && state.confirmed < state.indexed {
                                confirmation_wake.notify_one();
                            }
                            last_confirmed = state.confirmed;
                            for (label, count) in [
                                "raw_message_dispatch",
                                "message_delivery",
                                "gas_payment",
                                "merkle_tree_insertion",
                            ]
                            .into_iter()
                            .zip(counts)
                            {
                                sync_metrics
                                    .stored_events
                                    .with_label_values(&[label, legacy.domain.name()])
                                    .inc_by(count);
                            }
                            for label in [
                                "message_dispatch",
                                "message_delivery",
                                "gas_payment",
                                "merkle_tree_insertion",
                            ] {
                                sync_metrics
                                    .indexed_height
                                    .with_label_values(&[label, legacy.domain.name()])
                                    .set(i64::try_from(state.confirmed)?);
                            }
                        }
                        Ok::<_, eyre::Report>(())
                    }
                    .await;
                    if let Err(error) = result {
                        warn!(
                            domain = store.domain,
                            ?error,
                            "Near-head confirmation paused; retrying"
                        );
                    }
                    // Separate transaction: cleanup failures must not roll back publication.
                    if let Err(error) = store.prune_headers().await {
                        warn!(
                            domain = store.domain,
                            ?error,
                            "Block header cleanup failed; retrying"
                        );
                    }
                    tokio::select! {
                        _ = confirmation_wake.notified() => {},
                        _ = sleep(poll_interval) => {},
                    }
                }
            },
        );
    }))
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
    if head.height < state.confirmed {
        // A lagging RPC can report an older head without disproving our stored
        // chain. Pause until it catches up; only a hash mismatch proves a reorg.
        store.pause(false).await?;
        eyre::bail!("RPC head is behind confirmed history; waiting for a current observation");
    }
    let mut height = store.checkpoint(state.indexed.min(head.height)).await?;
    if head.height < state.indexed {
        store.pause(false).await?;
    }
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

async fn ingest(
    source: &dyn Source,
    store: &Store,
    state: &State,
    chunk_size: u64,
) -> Result<bool> {
    ensure!(chunk_size > 0, "Empty indexing range");
    if state.indexed == state.head {
        return Ok(false);
    }
    let end = state.head.min(state.indexed.saturating_add(chunk_size));
    let boundary = source.header(end.into()).await?;
    let mut by_block = BTreeMap::<u64, Vec<source::Event>>::new();
    for event in source.events(state.indexed.saturating_add(1), end).await? {
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
    Ok(end < state.head)
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
    let through = through
        .min(state.indexed)
        .min(state.confirmed.saturating_add(100));
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

/// One bounded page per event type, scheduled by the existing dispatch reconciler.
/// Advance before RPC work so unavailable receipts cannot starve later pages.
pub async fn enrich(legacy: &HyperlaneDbStore, cursors: &mut [i64; 2]) {
    let store = Store {
        db: legacy.db.clone_connection(),
        domain: legacy.domain.id(),
    };
    for (table, after) in ["delivered_message", "gas_payment"]
        .into_iter()
        .zip(cursors)
    {
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            let rows = store.unenriched(table, *after).await?;
            let start = *after;
            *after = rows.last().map(|(id, _)| *id).unwrap_or(0);
            if !rows.is_empty() {
                // Persist each receipt as it completes, retaining progress on timeout.
                stream::iter(rows.iter().map(Ok::<_, eyre::Report>))
                    .try_for_each_concurrent(8, |(_, meta)| async move {
                        let _transactions =
                            legacy.ensure_blocks_and_txns(std::iter::once(meta)).await?;
                        Ok(())
                    })
                    .await?;
                store.enrich(table, start, *after).await?;
            }
            Ok::<_, eyre::Report>(())
        })
        .await;
        if !matches!(result, Ok(Ok(()))) {
            warn!(
                domain = store.domain,
                table,
                ?result,
                "Confirmed event enrichment failed; retrying"
            );
        }
    }
}

#[cfg(test)]
mod tests;
