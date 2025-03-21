// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::path::PathBuf;

use hyperlane_base::settings::ChainConf;
use hyperlane_core::HyperlaneDomain;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::chain_tx_adapter::{AdaptsChain, ChainTxAdapterBuilder};

/// Settings for `PayloadDispatcher`
#[derive(Debug)]
pub struct PayloadDispatcherSettings {
    // settings needed for the adapter
    chain_conf: ChainConf,
    /// Follow how `Settings` is parsed from `RawAgentConf` to parse custom fields
    /// https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/ff0d4af74ecc586ef0c036e37fa4cf9c2ba5050e/rust/main/hyperlane-base/tests/chain_config.rs#L82
    // raw_json_settings: RawAgentConf,
    domain: HyperlaneDomain,

    db_path: PathBuf,
}

pub struct PayloadDispatcherState {
    // db: DispatcherDb,
    adapter: Box<dyn AdaptsChain>,
}

impl PayloadDispatcherState {
    pub fn new(settings: PayloadDispatcherSettings) -> Self {
        let adapter = ChainTxAdapterBuilder::build(&settings.chain_conf);
        Self { adapter }
    }
}
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
