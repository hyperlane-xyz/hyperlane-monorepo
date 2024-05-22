use std::ops::{Deref, DerefMut};

use derive_new::new;
use tokio::sync::broadcast::{Receiver, Sender};

/// Multi-producer, multi-consumer channel
pub struct MpmcChannel<T> {
    sender: Sender<T>,
    receiver: BroadcastReceiver<T>,
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
            receiver: BroadcastReceiver::new(sender, receiver),
        }
    }

    /// Returns a clone of the sender end of the channel.
    pub fn sender(&self) -> Sender<T> {
        self.sender.clone()
    }

    /// Returns a clone of the receiver end of the channel.
    pub fn receiver(&self) -> BroadcastReceiver<T> {
        self.receiver.clone()
    }
}

/// Clonable receiving end of a multi-producer, multi-consumer channel
#[derive(Debug, new)]
pub struct BroadcastReceiver<T> {
    sender: Sender<T>,
    /// The receiving end of the channel.
    pub receiver: Receiver<T>,
}

impl<T> Clone for BroadcastReceiver<T> {
    fn clone(&self) -> Self {
        Self {
            sender: self.sender.clone(),
            receiver: self.sender.subscribe(),
        }
    }
}

impl<T> Deref for BroadcastReceiver<T> {
    type Target = Receiver<T>;

    fn deref(&self) -> &Self::Target {
        &self.receiver
    }
}

impl<T> DerefMut for BroadcastReceiver<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.receiver
    }
}
