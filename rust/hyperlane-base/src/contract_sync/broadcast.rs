use derive_new::new;
use eyre::Result;
use hyperlane_core::H512;
use tokio::sync::mpsc::{Receiver as MpscReceiver, Sender as MpscSender};

#[derive(Debug, Clone, new)]
/// Wrapper around a vec of mpsc senders that broadcasts messages to all of them.
/// This is a workaround to get an async interface for `send`, so senders are blocked if any of the receiving channels is full,
/// rather than overwriting old messages (as the `broadcast` channel ring buffer implementation does).
pub struct BroadcastMpscSender<T> {
    capacity: usize,
    #[new(default)]
    sender: Vec<MpscSender<T>>,
}

impl BroadcastMpscSender<H512> {
    /// Send a message to all the receiving channels.
    // This will block if at least of the receiving channels is full
    pub async fn send(&self, txid: H512) -> Result<()> {
        for sender in &self.sender {
            sender.send(txid).await?
        }
        Ok(())
    }

    /// Get a receiver channel that will receive messages broadcasted by all the senders
    pub fn get_receiver(&mut self) -> MpscReceiver<H512> {
        let (sender, receiver) = tokio::sync::mpsc::channel(self.capacity);
        self.sender.push(sender);
        receiver
    }
}
