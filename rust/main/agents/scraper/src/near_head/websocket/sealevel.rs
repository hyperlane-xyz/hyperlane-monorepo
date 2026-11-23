//! Filter finalized program-account writes at the provider. Only HTTP indexing
//! can advance the scraper's durable frontier.
use eyre::{eyre, Result};
use futures::StreamExt;
use hyperlane_base::{settings::ChainConf, CoreMetrics};
use hyperlane_core::H256;
use hyperlane_sealevel::finalized_event_filters;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use tokio::{
    sync::watch,
    time::{interval, timeout, MissedTickBehavior},
};
use tracing::info;
use url::Url;

use super::{IndexWakeup, Worker, CONNECT_TIMEOUT, HEAD_STALL_TIMEOUT};
use crate::near_head::runtime::PolledEventSlots;

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
        worker.polled_event_slots.subscribe(),
        conf.domain.id(),
    )
    .await
}

pub(super) async fn subscribe_events(
    url: &Url,
    mailbox: H256,
    igp_program: H256,
    wakeup: &watch::Sender<IndexWakeup>,
    mut polled_events: watch::Receiver<Option<PolledEventSlots>>,
    domain: u32,
) -> Result<()> {
    // Establish the startup head before any subscription can deliver live events.
    polled_events.wait_for(Option::is_some).await?;
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
    // HTTP covers events indexed while the subscriptions were being installed.
    let initial = polled_events
        .borrow()
        .ok_or_else(|| eyre!("Missing Sealevel polling baseline"))?;
    let mut checkpoint = initial.indexed;
    let mut received = initial.indexed;
    info!(domain, "Finalized Sealevel event WebSocket subscribed");
    let mut stall_check = interval(HEAD_STALL_TIMEOUT);
    stall_check.reset();
    stall_check.set_missed_tick_behavior(MissedTickBehavior::Delay);
    IndexWakeup {
        height: 0,
        reconcile: true,
    }
    .send(wakeup);
    loop {
        let (stream, update) = tokio::select! {
            update = dispatch.next() => (0, update),
            update = delivery.next() => (1, update),
            update = payment.next() => (2, update),
            _ = stall_check.tick() => {
                if let Some(latest) = *polled_events.borrow() {
                    // Check the previous sample so newer events cannot extend the grace period.
                    let previous = std::mem::replace(&mut checkpoint, latest.indexed);
                    if previous.into_iter().zip(received).any(|(polled, received)| {
                        polled > received.max(initial.startup_head)
                    }) {
                        return Err(eyre!("Sealevel event subscription stalled behind polling"));
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
        IndexWakeup {
            height: slot,
            reconcile: false,
        }
        .send(wakeup);
    }
}
