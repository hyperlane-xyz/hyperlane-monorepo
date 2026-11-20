//! Filter finalized program-account writes at the provider. Only HTTP indexing
//! can advance the scraper's durable frontier.
use std::sync::atomic::{AtomicU64, Ordering};

use eyre::{eyre, Result};
use futures::StreamExt;
use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::H256;
use hyperlane_sealevel::finalized_event_filters;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use tokio::{
    sync::{watch, Notify},
    time::{interval, timeout, MissedTickBehavior},
};
use tracing::info;
use url::Url;

use super::{Worker, CONNECT_TIMEOUT, HEAD_STALL_TIMEOUT};

pub(super) async fn subscribe(
    url: &Url,
    conf: &ChainConf,
    metrics: &CoreMetrics,
    worker: &Worker,
) -> Result<()> {
    // The configured IGP address is a data account. Its owner is the program
    // that writes gas payment accounts across the indexed sequence.
    let igp = conf.build_interchain_gas_paymaster(metrics).await?;
    subscribe_events(
        url,
        conf.addresses.mailbox,
        igp.address(),
        &worker.wakeup,
        &worker.wanted,
        worker.polled_event_slots.subscribe(),
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
    polled_events: watch::Receiver<Option<[u64; 3]>>,
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
    let mut checkpoint = *polled_events.borrow();
    let mut received = checkpoint.unwrap_or_default();
    let mut stall_check = interval(HEAD_STALL_TIMEOUT);
    stall_check.reset();
    stall_check.set_missed_tick_behavior(MissedTickBehavior::Delay);
    wakeup.notify_one(); // Catch up across reconnects.
    loop {
        let (stream, update) = tokio::select! {
            update = dispatch.next() => (0, update),
            update = delivery.next() => (1, update),
            update = payment.next() => (2, update),
            _ = stall_check.tick() => {
                if let Some(latest) = *polled_events.borrow() {
                    if let Some(previous) = checkpoint.replace(latest) {
                        // Check the previous sample so newer events cannot extend the grace period.
                        if previous.into_iter().zip(received).any(|(polled, received)| polled > received) {
                            return Err(eyre!("Sealevel event subscription stalled behind polling"));
                        }
                    } else {
                        received = std::array::from_fn(|i| received[i].max(latest[i]));
                    }
                }
                continue;
            }
        };
        let slot = update
            .ok_or_else(|| eyre!("Sealevel event subscription closed"))?
            .context
            .slot;
        received[stream] = received[stream].max(slot);
        if slot > wanted.fetch_max(slot, Ordering::Relaxed) {
            wakeup.notify_one();
        }
    }
}
