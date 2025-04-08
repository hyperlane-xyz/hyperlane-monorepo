// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{path::PathBuf, sync::Arc};

use derive_new::new;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    settings::{ChainConf, RawChainConf},
    CoreMetrics,
};
use hyperlane_core::HyperlaneDomain;

use crate::chain_tx_adapter::{AdaptsChain, ChainTxAdapterFactory};

use super::PayloadDispatcherState;

/// Settings for `PayloadDispatcher`
#[derive(Debug)]
pub struct PayloadDispatcherSettings {
    // settings needed for the protocol-specific adapter
    pub chain_conf: ChainConf,
    /// settings needed for chain-specific adapter
    pub raw_chain_conf: RawChainConf,
    pub domain: HyperlaneDomain,
    pub db_path: PathBuf,
    pub metrics: Arc<CoreMetrics>,
}

pub struct PayloadDispatcher {
    inner: PayloadDispatcherState,
}

impl PayloadDispatcher {
    pub fn try_from_settings(settings: PayloadDispatcherSettings) -> Result<Self> {
        Ok(Self {
            inner: PayloadDispatcherState::try_from_settings(settings)?,
        })
    }

    pub fn spawn(self) -> Instrumented<JoinHandle<()>> {
        // TODO: here
        // create the submit queue and channels for the Dispatcher stages

        // spawn the DbLoader with references to the submit queue and channels
        // spawn the 3 stages using the adapter, db, queue and channels
        todo!()
    }
}
