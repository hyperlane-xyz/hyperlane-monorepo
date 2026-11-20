//! Filter finalized program-account writes at the provider. Only HTTP indexing
//! can advance the scraper's durable frontier.
use std::sync::atomic::{AtomicU64, Ordering};

use eyre::{eyre, Result};
use futures::StreamExt;
use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::H256;
use hyperlane_sealevel::finalized_event_filters;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use tokio::{sync::Notify, time::timeout};
use tracing::info;
use url::Url;

use super::CONNECT_TIMEOUT;

pub(super) async fn subscribe(
    url: &Url,
    conf: &ChainConf,
    metrics: &CoreMetrics,
    wakeup: &Notify,
    wanted: &AtomicU64,
) -> Result<()> {
    // The configured IGP address is a data account. Its owner is the program
    // that writes gas payment accounts across the indexed sequence.
    let igp = conf.build_interchain_gas_paymaster(metrics).await?;
    subscribe_events(
        url,
        conf.addresses.mailbox,
        igp.address(),
        wakeup,
        wanted,
        conf.domain.id(),
    )
    .await
}

pub(super) async fn subscribe_events(
    url: &Url,
    mailbox: H256,
    igp_program: H256,
    wakeup: &Notify,
    wanted: &AtomicU64,
    domain: u32,
) -> Result<()> {
    let client = timeout(CONNECT_TIMEOUT, PubsubClient::new(url.as_str())).await??;
    let filters = finalized_event_filters(mailbox, igp_program);
    let [dispatch, delivery, payment] = filters
        .each_ref()
        .map(|(program, config)| client.program_subscribe(program, Some(config.clone())));
    let ((mut dispatch, _), (mut delivery, _), (mut payment, _)) =
        timeout(CONNECT_TIMEOUT, async {
            tokio::try_join!(dispatch, delivery, payment)
        })
        .await??;
    info!(domain, "Finalized Sealevel event WebSocket subscribed");
    wakeup.notify_one(); // Catch up across reconnects.
    loop {
        let update = tokio::select! {
            update = dispatch.next() => update,
            update = delivery.next() => update,
            update = payment.next() => update,
        }
        .ok_or_else(|| eyre!("Sealevel event subscription closed"))?;
        let slot = update.context.slot;
        if slot > wanted.fetch_max(slot, Ordering::Relaxed) {
            wakeup.notify_one();
        }
    }
}
