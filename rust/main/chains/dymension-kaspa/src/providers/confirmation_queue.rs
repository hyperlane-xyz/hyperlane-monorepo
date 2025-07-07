use dym_kas_core::confirmation::ConfirmationFXG;
use std::sync::Mutex;

#[derive(Debug)]
pub struct PendingConfirmation {
    mutex: Mutex<Option<ConfirmationFXG>>,
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
}
