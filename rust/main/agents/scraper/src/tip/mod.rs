//! Disposable near-head observations alongside unchanged canonical indexers.
mod source;
mod store;

use ethers::types::{BlockNumber, H160};
use eyre::{ensure, Result};
use futures::{stream, StreamExt, TryStreamExt};
use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf},
    CoreMetrics,
};
use hyperlane_core::ContractLocator;
use sea_orm::DatabaseConnection;
use serde::Deserialize;
use source::{Contracts, Event, Header, Source, SourceBuilder};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use store::Store;
use tokio::{
    task::JoinHandle,
    time::{sleep, timeout, Instant},
};

/// An explicitly bounded observation cache, independent of canonical progress.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    /// Number of recent blocks retained, including the observed head.
    #[serde(alias = "windowblocks", deserialize_with = "config_u32")]
    pub window_blocks: u32,
}

fn config_u32<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u32, D::Error> {
    hyperlane_core::config::StrOrInt::deserialize(deserializer)?
        .try_into()
        .map_err(serde::de::Error::custom)
}

/// Start an optional overlay without replacing or delaying canonical indexers.
pub async fn spawn(
    conf: &ChainConf,
    config: &Config,
    db: DatabaseConnection,
    metrics: Arc<CoreMetrics>,
) -> Result<JoinHandle<()>> {
    ensure!(
        config.window_blocks > 0,
        "tip.windowBlocks must be positive"
    );
    ensure!(conf.index.chunk_size > 0, "index.chunk must be positive");
    let ChainConnectionConf::Ethereum(connection) = &conf.connection else {
        eyre::bail!("tip requires an EVM chain");
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
                contracts,
                domain: conf.domain.id(),
            },
        )
        .await?;
    let store = Store {
        db,
        domain: conf.domain.id(),
    };
    // A restart/config change invalidates the disposable cache. Canonical state
    // never participates in this operation.
    store.reset().await?;
    let window = u64::from(config.window_blocks);
    let chunk = u64::from(conf.index.chunk_size);
    let poll = conf
        .index
        .configured_interval
        .unwrap_or(Duration::from_secs(30));
    ensure!(!poll.is_zero(), "index.interval must be positive");
    let lease = poll.saturating_mul(3).max(Duration::from_secs(30));
    Ok(tokio::spawn(async move {
        loop {
            match timeout(
                Duration::from_secs(120),
                tick(source.as_ref(), &store, window, chunk, lease),
            )
            .await
            {
                Ok(Ok(true)) => continue,
                Ok(Ok(false)) => {}
                error => {
                    // The lease also hides observations if the database is down.
                    if let Err(pause_error) = store.pause().await {
                        tracing::warn!(
                            ?pause_error,
                            domain = store.domain,
                            "Failed to hide tip overlay"
                        );
                    }
                    tracing::warn!(
                        ?error,
                        domain = store.domain,
                        "Tip overlay unavailable; canonical indexing continues"
                    );
                }
            }
            sleep(poll).await;
        }
    }))
}

async fn tick(
    source: &dyn Source,
    store: &Store,
    window: u64,
    chunk: u64,
    lease: Duration,
) -> Result<bool> {
    let mut state = store.state().await?;
    let head = source.header(BlockNumber::Latest).await?;
    let observed = Instant::now();
    let first = head.height.saturating_sub(window.saturating_sub(1));
    let mut reset = true;
    if let Some((height, hash)) = state.indexed {
        if height <= head.height && height >= first.saturating_sub(1) {
            let previous = if height == head.height {
                head.clone()
            } else {
                source.header(height.into()).await?
            };
            reset = previous.hash != hash;
        }
    }
    if reset {
        state.revision = store.pause_revision(state.revision).await?;
    }
    let start = if reset {
        first
    } else {
        state
            .indexed
            .map(|(height, _)| height.saturating_add(1))
            .unwrap_or(first)
    };
    if start > head.height {
        store
            .commit(
                &state,
                &head,
                first,
                &[],
                false,
                true,
                remaining_lease(lease, observed)?,
            )
            .await?;
        return Ok(false);
    }
    let end = head
        .height
        .min(start.saturating_add(chunk.saturating_sub(1)));
    let boundary = if end == head.height {
        head.clone()
    } else {
        source.header(end.into()).await?
    };
    let events = fetch(source, start, end, &boundary).await?;
    // Re-read both anchors after fetching the range. Provider consistency is
    // required, as for ordinary range indexers; omitted logs cannot be detected.
    if !reset {
        if let Some((height, hash)) = state.indexed {
            ensure!(
                source.header(height.into()).await?.hash == hash,
                "Tip ancestor changed during fetch"
            );
        }
    }
    ensure!(
        source.header(end.into()).await?.hash == boundary.hash,
        "Tip changed during fetch"
    );
    store
        .commit(
            &state,
            &boundary,
            first,
            &events,
            reset,
            end == head.height,
            remaining_lease(lease, observed)?,
        )
        .await?;
    Ok(end < head.height)
}

fn remaining_lease(lease: Duration, observed: Instant) -> Result<Duration> {
    lease
        .checked_sub(observed.elapsed())
        .filter(|remaining| !remaining.is_zero())
        .ok_or_else(|| eyre::eyre!("Tip observation expired during fetch"))
}

async fn fetch(source: &dyn Source, start: u64, end: u64, boundary: &Header) -> Result<Vec<Event>> {
    let mut blocks = BTreeMap::<u64, Vec<Event>>::new();
    for event in source.events(start, end).await? {
        ensure!(
            (start..=end).contains(&event.block_number),
            "Event outside range"
        );
        blocks.entry(event.block_number).or_default().push(event);
    }
    let pages: Vec<Vec<Event>> = stream::iter(blocks)
        .map(|(height, events)| async move {
            let header = if height == boundary.height {
                boundary.clone()
            } else {
                source.header(height.into()).await?
            };
            ensure!(
                events.iter().all(|event| event.block_hash == header.hash),
                "Logs disagree with header"
            );
            Ok::<_, eyre::Report>(events)
        })
        .buffered(8)
        .try_collect()
        .await?;
    Ok(pages.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests;
