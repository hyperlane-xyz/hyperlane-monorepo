use derive_new::new;
use tokio::sync::broadcast::{Receiver, Sender};

/// Clonable receiving end of a multi-producer, multi-consumer channel
#[derive(Debug, new)]
pub struct MpmcReceiver<T> {
    sender: Sender<T>,
    /// Get the receiver
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
