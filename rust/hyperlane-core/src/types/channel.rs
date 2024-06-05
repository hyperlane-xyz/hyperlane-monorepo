use std::ops::{Deref, DerefMut};

use derive_new::new;
use tokio::sync::broadcast::{Receiver, Sender};

/// Multi-producer, multi-consumer channel
pub struct MpmcChannel<T> {
    sender: Sender<T>,
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
        }
    }

    /// Returns a clone of the sender end of the channel.
    pub fn sender(&self) -> Sender<T> {
        self.sender.clone()
    }

    /// Returns a clone of the receiver end of the channel.
    pub fn receiver(&self) -> Receiver<T> {
        self.sender.subscribe()
    }
}
