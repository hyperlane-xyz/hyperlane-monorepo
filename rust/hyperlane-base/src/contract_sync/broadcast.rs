use std::sync::Arc;

use derive_new::new;
use eyre::Result;
use hyperlane_core::H512;
use tokio::sync::{
    mpsc::{Receiver as MpscReceiver, Sender as MpscSender},
    Mutex,
};

#[derive(Debug, Clone, new)]
/// Wrapper around a vec of mpsc senders that broadcasts messages to all of them.
/// This is a workaround to get an async interface for `send`, so senders are blocked if any of the receiving channels is full,
/// rather than overwriting old messages (as the `broadcast` channel ring buffer implementation does).
pub struct BroadcastMpscSender<T> {
    capacity: usize,
    /// To make this safe to `Clone`, the sending end has to be in an arc-mutex.
    /// Otherwise it would be possible to call `get_receiver` and create new receiver-sender pairs, whose sender is later dropped
    /// because the other `BroadcastMpscSender`s have no reference to it. The receiver would then point to a closed
    /// channel. So all instances of `BroadcastMpscSender` have to point to the entire set of senders.
    #[new(default)]
    sender: Arc<Mutex<Vec<MpscSender<T>>>>,
}

impl BroadcastMpscSender<H512> {
    /// Send a message to all the receiving channels.
    // This will block if at least one of the receiving channels is full
    pub async fn send(&self, txid: H512) -> Result<()> {
        let senders = self.sender.lock().await;
        for sender in &*senders {
            sender.send(txid).await?
        }
        Ok(())
    }

    /// Get a receiver channel that will receive messages broadcasted by all the senders
    pub async fn get_receiver(&self) -> MpscReceiver<H512> {
        let (sender, receiver) = tokio::sync::mpsc::channel(self.capacity);

        self.sender.lock().await.push(sender);
        receiver
    }

    /// Utility function map an option of `BroadcastMpscSender` to an option of `MpscReceiver`
    pub async fn map_get_receiver(maybe_self: Option<&Self>) -> Option<MpscReceiver<H512>> {
        if let Some(s) = maybe_self {
            Some(s.get_receiver().await)
        } else {
            None
        }
    }
}
