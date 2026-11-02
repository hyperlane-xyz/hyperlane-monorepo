use std::sync::{Arc, OnceLock};

use derive_new::new;
use eyre::{eyre, Result};
use futures::{stream::FuturesUnordered, StreamExt};
use hyperlane_core::H512;
use tokio::{
    sync::{
        mpsc::{self, Receiver as MpscReceiver, Sender as MpscSender},
        oneshot,
    },
    task::AbortHandle,
};

// One queued broadcast in addition to the one being delivered. Producers wait
// for both admission and delivery; slow consumers cannot create an unbounded queue.
const COMMAND_CAPACITY: usize = 1;

#[derive(Debug, Clone, new)]
/// Lossless fanout to bounded subscriber channels. An actor owns the subscriber
/// list and preserves broadcast order while delivering to subscribers concurrently.
pub struct BroadcastMpscSender<T> {
    capacity: usize,
    // Lazy initialization keeps construction usable outside a Tokio runtime.
    #[new(default)]
    actor: Arc<OnceLock<BroadcastActor<T>>>,
}

#[derive(Debug)]
struct BroadcastActor<T> {
    broadcasts: MpscSender<BroadcastRequest<T>>,
    subscriptions: MpscSender<Subscription<T>>,
    task: AbortHandle,
}

impl<T> Drop for BroadcastActor<T> {
    fn drop(&mut self) {
        // No detached worker survives the last broadcaster, even when a
        // subscriber stays alive without draining its channel.
        self.task.abort();
    }
}

#[derive(Debug)]
struct BroadcastRequest<T> {
    ready: oneshot::Sender<BroadcastTurn<T>>,
}

#[derive(Debug)]
struct BroadcastTurn<T> {
    senders: Vec<MpscSender<T>>,
    // Releasing the turn lets the actor admit the next broadcast. Delivery
    // futures stay in the caller so cancellation drops them synchronously.
    _finished: oneshot::Sender<()>,
}

#[derive(Debug)]
struct Subscription<T> {
    sender: MpscSender<T>,
    registered: oneshot::Sender<()>,
}

/// Cursor-indexed transaction and the stored event sequences it contained.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IndexingNotification {
    /// Indexed transaction id.
    pub tx_id: H512,
    /// Sequence numbers stored from the transaction.
    pub sequences: Vec<Option<u32>>,
}

impl IndexingNotification {
    /// Build a notification for a transaction without sequence metadata.
    pub fn from_tx_id(tx_id: H512) -> Self {
        Self {
            tx_id,
            sequences: Vec::new(),
        }
    }
}

impl<T: Clone + Send + 'static> BroadcastMpscSender<T> {
    fn actor(&self) -> &BroadcastActor<T> {
        self.actor.get_or_init(|| {
            let (broadcasts, broadcast_receiver) = mpsc::channel(COMMAND_CAPACITY);
            let (subscriptions, subscription_receiver) = mpsc::channel(COMMAND_CAPACITY);
            let task = tokio::spawn(Self::run(broadcast_receiver, subscription_receiver));
            BroadcastActor {
                broadcasts,
                subscriptions,
                task: task.abort_handle(),
            }
        })
    }

    fn register(senders: &mut Vec<MpscSender<T>>, subscription: Subscription<T>) {
        if !subscription.registered.is_closed() {
            senders.retain(|sender| !sender.is_closed());
            senders.push(subscription.sender);
            let _ = subscription.registered.send(());
        }
    }

    async fn run(
        mut broadcasts: MpscReceiver<BroadcastRequest<T>>,
        mut subscriptions: MpscReceiver<Subscription<T>>,
    ) {
        let mut senders = Vec::<MpscSender<T>>::new();
        loop {
            let request = tokio::select! {
                Some(subscription) = subscriptions.recv() => {
                    Self::register(&mut senders, subscription);
                    continue;
                }
                Some(request) = broadcasts.recv() => request,
                else => break,
            };
            senders.retain(|sender| !sender.is_closed());
            let (finished, mut completion) = oneshot::channel();
            let turn = BroadcastTurn {
                senders: senders.clone(),
                _finished: finished,
            };
            if request.ready.send(turn).is_err() {
                continue;
            }
            loop {
                tokio::select! {
                    _ = &mut completion => break,
                    Some(subscription) = subscriptions.recv() => {
                        // New subscribers start with the next broadcast.
                        Self::register(&mut senders, subscription);
                    }
                }
            }
        }
    }

    /// Send to every current subscriber, waiting for slow subscribers without
    /// delaying delivery to ready ones. Dropping this future cancels pending
    /// deliveries; messages already enqueued in subscriber channels remain there.
    pub async fn send(&self, message: T) -> Result<()> {
        let (ready, receiver) = oneshot::channel();
        self.actor()
            .broadcasts
            .send(BroadcastRequest { ready })
            .await
            .map_err(|_| eyre!("Indexing notification broadcaster stopped"))?;
        let turn = receiver
            .await
            .map_err(|_| eyre!("Indexing notification broadcaster stopped"))?;
        let mut deliveries: FuturesUnordered<_> = turn
            .senders
            .iter()
            .map(|sender| sender.send(message.clone()))
            .collect();
        while deliveries.next().await.is_some() {}
        Ok(())
    }

    /// Subscribe without waiting for an in-progress broadcast's backpressure.
    pub async fn get_receiver(&self) -> MpscReceiver<T> {
        let (sender, receiver) = mpsc::channel(self.capacity);
        let (registered, registration) = oneshot::channel();
        self.actor()
            .subscriptions
            .send(Subscription { sender, registered })
            .await
            .expect("Indexing notification broadcaster stopped");
        registration
            .await
            .expect("Indexing notification broadcaster stopped");
        receiver
    }

    /// Utility function map an option of `BroadcastMpscSender` to an option of `MpscReceiver`
    pub async fn map_get_receiver(maybe_self: Option<&Self>) -> Option<MpscReceiver<T>> {
        if let Some(s) = maybe_self {
            Some(s.get_receiver().await)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use futures::poll;
    use tokio::time::timeout;

    use super::*;

    #[tokio::test]
    async fn disconnected_subscriber_does_not_block_later_subscribers() {
        let broadcaster = BroadcastMpscSender::new(1);
        let disconnected_receiver = broadcaster.get_receiver().await;
        let mut live_receiver = broadcaster.get_receiver().await;
        drop(disconnected_receiver);

        for txid in [H512::from_low_u64_be(1), H512::from_low_u64_be(2)] {
            broadcaster.send(txid).await.unwrap();
            assert_eq!(live_receiver.recv().await, Some(txid));
        }
    }

    #[tokio::test]
    async fn slow_subscriber_does_not_delay_ready_subscribers_or_registration() {
        timeout(Duration::from_secs(1), async {
            let broadcaster = BroadcastMpscSender::new(1);
            let mut slow = broadcaster.get_receiver().await;
            let mut ready = broadcaster.get_receiver().await;
            broadcaster.send(1).await.unwrap();
            assert_eq!(ready.recv().await, Some(1));

            let send = broadcaster.send(2);
            tokio::pin!(send);
            assert!(poll!(&mut send).is_pending());
            tokio::select! {
                result = &mut send => panic!("full subscriber should block send: {result:?}"),
                value = ready.recv() => assert_eq!(value, Some(2)),
            }
            assert!(poll!(&mut send).is_pending());
            let mut late = broadcaster.get_receiver().await;
            assert!(late.try_recv().is_err());

            assert_eq!(slow.recv().await, Some(1));
            send.await.unwrap();
            assert_eq!(slow.recv().await, Some(2));
            broadcaster.send(3).await.unwrap();
            assert_eq!(late.recv().await, Some(3));
        })
        .await
        .expect("fanout or registration stalled behind a slow subscriber");
    }

    #[tokio::test]
    async fn concurrent_broadcasts_have_the_same_order_for_all_subscribers() {
        timeout(Duration::from_secs(1), async {
            let broadcaster = BroadcastMpscSender::new(1);
            let mut first = broadcaster.get_receiver().await;
            let mut second = broadcaster.clone().get_receiver().await;
            let sends = futures::future::join_all((0..32).map(|value| broadcaster.send(value)));
            let drain = async {
                let mut values = Vec::new();
                for _ in 0..32 {
                    let (a, b) = tokio::join!(first.recv(), second.recv());
                    assert_eq!(a, b);
                    values.push(a.unwrap());
                }
                values.sort_unstable();
                assert_eq!(values, (0..32).collect::<Vec<_>>());
            };
            let (results, _) = tokio::join!(sends, drain);
            assert!(results.into_iter().all(|result| result.is_ok()));
        })
        .await
        .expect("concurrent broadcasts stalled");
    }

    #[tokio::test]
    async fn cancelled_broadcast_releases_backpressure() {
        timeout(Duration::from_secs(1), async {
            let broadcaster = BroadcastMpscSender::new(1);
            let mut slow = broadcaster.get_receiver().await;
            let mut ready = broadcaster.get_receiver().await;
            broadcaster.send(1).await.unwrap();
            assert_eq!(ready.recv().await, Some(1));

            let mut send = Box::pin(broadcaster.send(2));
            assert!(poll!(&mut send).is_pending());
            tokio::select! {
                result = &mut send => panic!("full subscriber should block send: {result:?}"),
                value = ready.recv() => assert_eq!(value, Some(2)),
            }
            drop(send);
            // The actor continues serving subscriptions after cancellation.
            let mut late = broadcaster.get_receiver().await;
            assert_eq!(slow.recv().await, Some(1));
            // The next broadcast must finish and preserve subscriber ordering.
            let next = broadcaster.send(3);
            let drain = async {
                assert_eq!(slow.recv().await, Some(3));
            };
            let (result, _) = tokio::join!(next, drain);
            result.unwrap();
            assert_eq!(late.recv().await, Some(3));
        })
        .await
        .expect("cancelled broadcast stranded the actor");
    }

    #[tokio::test]
    async fn full_subscriber_bounds_broadcast_admission() {
        timeout(Duration::from_secs(1), async {
            let broadcaster = BroadcastMpscSender::new(1);
            let slow = broadcaster.get_receiver().await;
            let mut ready = broadcaster.get_receiver().await;
            broadcaster.send(1).await.unwrap();
            assert_eq!(ready.recv().await, Some(1));

            let second = broadcaster.send(2);
            tokio::pin!(second);
            assert!(poll!(&mut second).is_pending());
            tokio::select! {
                result = &mut second => panic!("full subscriber should block send: {result:?}"),
                value = ready.recv() => assert_eq!(value, Some(2)),
            }

            let third = broadcaster.send(3);
            tokio::pin!(third);
            assert!(poll!(&mut third).is_pending());
            assert_eq!(broadcaster.actor().broadcasts.capacity(), 0);
            let fourth = broadcaster.send(4);
            tokio::pin!(fourth);
            assert!(poll!(&mut fourth).is_pending());
            assert_eq!(broadcaster.actor().broadcasts.capacity(), 0);

            drop(slow);
            let drain = async {
                assert_eq!(ready.recv().await, Some(3));
                assert_eq!(ready.recv().await, Some(4));
            };
            let (second, third, fourth, _) = tokio::join!(second, third, fourth, drain);
            second.unwrap();
            third.unwrap();
            fourth.unwrap();
        })
        .await
        .expect("bounded broadcast admission failed to resume");
    }

    #[tokio::test]
    async fn cancelling_queued_broadcast_does_not_strand_later_turns() {
        timeout(Duration::from_secs(1), async {
            let broadcaster = BroadcastMpscSender::new(1);
            let slow = broadcaster.get_receiver().await;
            let mut ready = broadcaster.get_receiver().await;
            broadcaster.send(1).await.unwrap();
            assert_eq!(ready.recv().await, Some(1));

            let second = broadcaster.send(2);
            tokio::pin!(second);
            tokio::select! {
                result = &mut second => panic!("full subscriber should block send: {result:?}"),
                value = ready.recv() => assert_eq!(value, Some(2)),
            }
            let mut cancelled = Box::pin(broadcaster.send(3));
            assert!(poll!(&mut cancelled).is_pending());
            assert_eq!(broadcaster.actor().broadcasts.capacity(), 0);
            drop(cancelled);

            drop(slow);
            let fourth = broadcaster.send(4);
            let drain = async {
                assert_eq!(ready.recv().await, Some(4));
            };
            let (second, fourth, _) = tokio::join!(second, fourth, drain);
            second.unwrap();
            fourth.unwrap();
        })
        .await
        .expect("cancelled queued broadcast stranded admission");
    }

    #[tokio::test]
    async fn dropping_last_broadcaster_closes_subscribers() {
        let broadcaster = BroadcastMpscSender::<u32>::new(1);
        let mut receiver = broadcaster.get_receiver().await;
        let clone = broadcaster.clone();
        drop(broadcaster);
        clone.send(1).await.unwrap();
        drop(clone);
        assert_eq!(receiver.recv().await, Some(1));
        assert_eq!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .unwrap(),
            None
        );
    }
}
