use derive_new::new;
use tokio::sync::broadcast::{Receiver, Sender};

/// Multi-producer, multi-consumer channel
pub struct MpmcChannel<T> {
    sender: Sender<T>,
    receiver: MpmcReceiver<T>,
}

impl<T: Clone> MpmcChannel<T> {
    /// Creates a new `MpmcChannel` with the specified capacity.
    ///
    /// # Arguments
    ///
    /// * `capacity` - The maximum number of messages that can be buffered in the channel.
    pub fn new(capacity: usize) -> Self {
        let (sender, receiver) = tokio::sync::broadcast::channel(capacity);
        Self {
            sender: sender.clone(),
            receiver: MpmcReceiver::new(sender, receiver),
        }
    }

    /// Returns a clone of the sender end of the channel.
    pub fn sender(&self) -> Sender<T> {
        self.sender.clone()
    }

    /// Returns a clone of the receiver end of the channel.
    pub fn receiver(&self) -> MpmcReceiver<T> {
        self.receiver.clone()
    }
}

/// Clonable receiving end of a multi-producer, multi-consumer channel
#[derive(Debug, new)]
pub struct MpmcReceiver<T> {
    sender: Sender<T>,
    /// The receiving end of the channel.
    pub receiver: Receiver<T>,
}

impl<T> Clone for MpmcReceiver<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
            receiver: self.sender.subscribe(),
        }
    }
}
