// TODO: re-enable clippy warnings
#![allow(dead_code)]

use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::payload_dispatcher::settings::PayloadDispatcherSettings;
use crate::payload_dispatcher::state::PayloadDispatcherState;

pub struct PayloadDispatcher {
    inner: PayloadDispatcherState,
}

impl PayloadDispatcher {
    pub fn new(settings: PayloadDispatcherSettings) -> Self {
        Self {
            inner: PayloadDispatcherState::new(settings),
        }
    }

    pub fn spawn(self) -> Instrumented<JoinHandle<()>> {
        // create the submit queue and channels for the Dispatcher stages
        // spawn the DbLoader with references to the submit queue and channels
        // spawn the 3 stages using the adapter, db, queue and channels
        todo!()
    }
}
