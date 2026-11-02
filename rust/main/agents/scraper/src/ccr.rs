//! Index same-chain CCR swaps through the confirmed frontier.
use crate::{settings::ScraperSettings, store::HyperlaneDbStore};
use hyperlane_base::{settings::IndexSettings, CoreMetrics};
use hyperlane_core::{
    rpc_clients::RPC_RETRY_SLEEP_DURATION, HyperlaneDomain, HyperlaneLogStore, SameChainCcrSwap,
};
use std::{sync::Arc, time::Duration};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info_span, warn, Instrument};

/// Build a CCR swap indexer for the given domain if it has CCR routers configured.
/// Returns `None` if the domain has no CCR config.
pub(crate) async fn spawn(
    settings: &ScraperSettings,
    domain: HyperlaneDomain,
    metrics: Arc<CoreMetrics>,
    store: HyperlaneDbStore,
    index_settings: IndexSettings,
) -> eyre::Result<Option<JoinHandle<()>>> {
    let ccr_router_map = match settings.ccr_routers.get(&domain.id()) {
        Some(m) if !m.is_empty() => m,
        _ => return Ok(None),
    };

    let ccr_to_erc20 = ccr_router_map.clone();
    let local_domain = domain.id();

    let chain_setup = settings.chain_setup(&domain)?;
    let Some(indexer) = chain_setup
        .build_ccr_swap_indexer(&metrics, local_domain, ccr_to_erc20)
        .await?
    else {
        return Ok(None);
    };

    let chunk_size = index_settings.chunk_size;
    if chunk_size == 0 {
        warn!(?domain, "index.chunk must be > 0 for CCR sync; skipping");
        return Ok(None);
    }
    let default_from = index_settings.from.max(0) as u32;

    // Create a dedicated BlockCursor for CCR swaps keyed by (domain, "ccr_swap").
    // Near-head event progress is tracked separately in scraper_head.
    let ccr_cursor = Arc::new(
        store
            .db
            .block_cursor(local_domain, "ccr_swap", default_from.into())
            .await?,
    );

    Ok(Some(tokio::spawn(
        async move {
            let mut from_block = ccr_cursor.height().await as u32;

            loop {
                let tip = match async {
                    let tip = indexer.get_finalized_block_number().await?;
                    Ok::<_, eyre::Report>(tip.min(
                        crate::near_head::confirmed_height(&store.db, local_domain).await?,
                    ))
                }.await {
                    Ok(tip) => tip,
                    Err(err) => {
                        warn!(?err, "Failed to get finalized block number for CCR indexer");
                        sleep(RPC_RETRY_SLEEP_DURATION).await;
                        continue;
                    }
                };

                if from_block > tip {
                    sleep(Duration::from_secs(5)).await;
                    continue;
                }

                let to_block = tip.min(from_block.saturating_add(chunk_size).saturating_sub(1));

                let logs = match indexer.fetch_logs_in_range(from_block..=to_block).await {
                    Ok(logs) => logs,
                    Err(err) => {
                        warn!(?err, from_block, to_block, "Failed to fetch CCR swap logs");
                        sleep(RPC_RETRY_SLEEP_DURATION).await;
                        continue;
                    }
                };

                if !logs.is_empty() {
                    if let Err(err) =
                        HyperlaneLogStore::<SameChainCcrSwap>::store_logs(&store, &logs).await
                    {
                        warn!(
                            ?err,
                            from_block, to_block, "Failed to store CCR swaps; retrying range"
                        );
                        sleep(RPC_RETRY_SLEEP_DURATION).await;
                        continue;
                    }
                }

                if !matches!(ccr_cursor.update(to_block.into()).await, Ok(true)) {
                    if let Err(e) = ccr_cursor.flush().await {
                        warn!(?e, from_block, to_block, "Failed to flush CCR cursor; advancing anyway, next flush will catch up");
                    }
                }
                from_block = to_block.saturating_add(1);
            }
        }
        .instrument(info_span!("CcrSwapSync", chain=%domain.name())),
    )))
}
