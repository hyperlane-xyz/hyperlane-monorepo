// TODO: re-enable clippy warnings
#![allow(dead_code)]

use eyre::Result;
use std::path::PathBuf;

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    settings::{ChainConf, RawChainConf},
};
use hyperlane_core::HyperlaneDomain;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use crate::{
    chain_tx_adapter::{AdaptsChain, ChainTxAdapterBuilder},
    payload::PayloadDb,
};

/// Settings for `PayloadDispatcher`
#[derive(Debug)]
pub struct PayloadDispatcherSettings {
    // settings needed for the protocol-specific adapter
    chain_conf: ChainConf,
    /// settings needed for chain-specific adapter
    raw_chain_conf: RawChainConf,
    domain: HyperlaneDomain,
    db_path: PathBuf,
}

pub struct PayloadDispatcherState {
    pub(crate) db: Box<dyn PayloadDb>,
    pub(crate) adapter: Box<dyn AdaptsChain>,
}

impl PayloadDispatcherState {
    pub fn new(db: Box<dyn PayloadDb>, adapter: Box<dyn AdaptsChain>) -> Self {
        Self { db, adapter }
    }

    pub fn try_from_settings(settings: PayloadDispatcherSettings) -> Result<Self> {
        let adapter = ChainTxAdapterBuilder::build(&settings.chain_conf, &settings.raw_chain_conf);
        let db = DB::from_path(&settings.db_path)?;
        let rocksdb = HyperlaneRocksDB::new(&settings.domain, db);
        let payload_db = Box::new(rocksdb) as Box<dyn PayloadDb>;
        Ok(Self::new(payload_db, adapter))
    }
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
        // create the submit queue and channels for the Dispatcher stages
        // spawn the DbLoader with references to the submit queue and channels
        // spawn the 3 stages using the adapter, db, queue and channels
        todo!()
    }
}
