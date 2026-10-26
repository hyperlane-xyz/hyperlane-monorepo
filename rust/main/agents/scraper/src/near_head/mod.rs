//! Core event-indexing pipeline for every configured chain: ingest near head, publish after confirmation.
mod enrichment;
mod pipeline;
mod runtime;
mod source;
mod store;

use std::{sync::Arc, time::Duration};

use eyre::{ensure, Result};
use hyperlane_base::{
    settings::{ChainConf, ChainConnectionConf},
    ChainMetrics, ContractSyncMetrics, CoreMetrics,
};
use hyperlane_core::{ContractLocator, HyperlaneDomainProtocol, ReorgPeriod};
use tokio::task::JoinHandle;

use crate::store::HyperlaneDbStore;
use pipeline::tag_selector;
use source::{
    BlockSelector, Contracts, EvmContracts, GenericSource, Header, Source, SourceBuilder,
};
use store::Store;

const CRITICAL_FAILURE_GRACE: Duration = Duration::from_secs(60);

fn minimum_auto_anchor(protocol: HyperlaneDomainProtocol) -> u64 {
    match protocol {
        HyperlaneDomainProtocol::Cosmos | HyperlaneDomainProtocol::CosmosNative => 1,
        _ => 0,
    }
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

/// Start the chain’s indexing and independent receipt-enrichment workers.
pub async fn spawn(
    conf: &ChainConf,
    enrichment_store: HyperlaneDbStore,
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
        db: enrichment_store.db.clone_connection(),
        domain: conf.domain.id(),
    };
    let initialized = store.state().await?.is_some();
    let protocol = conf.connection.protocol();
    let anchor = if initialized {
        None
    } else if protocol == HyperlaneDomainProtocol::Radix {
        Some(source.empty_anchor().await?.ok_or_else(|| {
            eyre::eyre!("Radix near-head indexing requires an explicit scraper_head cutover when event history exists")
        })?)
    } else if !source.indexes_by_sequence() {
        let index_from = if conf.index.from < 0 {
            let tip = source.header(BlockSelector::Latest).await?.height;
            resolve_index_from(conf.index.from, tip)?
        } else {
            resolve_index_from(conf.index.from, 0)?
        };
        let anchor_height = store
            .anchor_height(index_from)
            .await?
            .max(minimum_auto_anchor(protocol));
        Some(source.header(BlockSelector::Height(anchor_height)).await?)
    } else {
        Some(source.empty_anchor().await?.ok_or_else(|| {
            eyre::eyre!("Sequence near-head indexing requires an explicit scraper_head cutover when event history exists")
        })?)
    };
    let period = conf.reorg_period.clone();
    ensure!(conf.index.chunk_size > 0, "index.chunk must be positive");
    let chunk_size = u64::from(conf.index.chunk_size);
    let poll_interval = conf.index.idle_sleep_duration;
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
        domain: enrichment_store.domain.clone(),
        period,
        chunk_size,
        poll_interval,
        critical_failure_grace: CRITICAL_FAILURE_GRACE,
        chain_metrics,
        sync_metrics,
    };
    Ok(tokio::spawn(async move {
        tokio::join!(
            worker.run(),
            enrichment::run(&enrichment_store, poll_interval, &receipt_age)
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
    match store.state().await? {
        Some(_) => {
            store.validate_checkpoints().await?;
            store.validate_contracts(contracts).await?;
        }
        None => {
            anchor.ok_or_else(|| eyre::eyre!("Missing first-start anchor"))?;
        }
    }
    let current = source.header(BlockSelector::Latest).await?;
    source.counts(current.hash).await?;
    if let Some(anchor) = anchor {
        store.initialize(anchor, contracts).await?;
    }
    Ok(())
}

fn resolve_index_from(index_from: i64, tip: u64) -> Result<u64> {
    Ok(u64::try_from(
        i128::from(tip)
            .saturating_add(i128::from(index_from))
            .max(0),
    )?)
}

#[cfg(test)]
mod tests;
