// TODO: re-enable clippy warnings
#![allow(dead_code)]

use super::{PayloadDispatcherSettings, PayloadDispatcherState};

pub struct PayloadDispatcherEntrypoint {
    inner: PayloadDispatcherState,
}

impl PayloadDispatcherEntrypoint {
    pub fn new(settings: PayloadDispatcherSettings) -> Self {
        Self {
            inner: PayloadDispatcherState::new(settings),
        }
    }
}
