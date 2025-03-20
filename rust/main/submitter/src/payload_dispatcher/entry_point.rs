// TODO: re-enable clippy warnings
#![allow(dead_code)]

use crate::payload_dispatcher::settings::PayloadDispatcherSettings;
use crate::payload_dispatcher::state::PayloadDispatcherState;

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
