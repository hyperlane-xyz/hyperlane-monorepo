use crate::ops::confirmation::ConfirmationFXG;
use std::sync::Mutex;

#[derive(Debug)]
pub struct PendingConfirmation {
    mutex: Mutex<Option<ConfirmationFXG>>,
}

impl Default for PendingConfirmation {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingConfirmation {
    pub fn new() -> Self {
        Self {
            mutex: Mutex::new(None),
        }
    }

    pub fn consume(&self) -> Option<ConfirmationFXG> {
        let mut guard = self.mutex.lock().unwrap();
        std::mem::take(&mut *guard)
    }
    pub fn push(&self, fxg: ConfirmationFXG) {
        let mut guard = self.mutex.lock().unwrap();
        *guard = Some(fxg);
    }
    /// has_pending checks if there's a pending ConfirmationFXG
    pub fn has_pending(&self) -> bool {
        let guard = self.mutex.lock().unwrap(); // Acquire lock
        guard.is_some() // Check if the Option contains a value
    }

    /// returns pending ConfirmationFXG without consuming
    pub fn get_pending(&self) -> Option<ConfirmationFXG> {
        let guard = self.mutex.lock().unwrap();
        guard.as_ref().cloned() // Requires ConfirmationFXG to implement Clone
    }
}
