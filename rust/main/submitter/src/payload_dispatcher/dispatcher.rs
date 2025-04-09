// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, path::PathBuf, sync::Arc};

use derive_new::new;
use eyre::Result;
use futures_util::future::join_all;
use tokio::{sync::Mutex, task::JoinHandle};
use tracing::{instrument::Instrumented, Instrument};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    settings::{ChainConf, RawChainConf},
    CoreMetrics,
};
use hyperlane_core::HyperlaneDomain;

use crate::{
    chain_tx_adapter::{AdaptsChain, ChainTxAdapterFactory},
    payload_dispatcher::{
        BuildingStage, BuildingStageQueue, FinalityStage, InclusionStage, PayloadDbLoader,
    },
    transaction::Transaction,
};

use super::{PayloadDispatcherState, TransactionDbLoader};

const SUBMITTER_CHANNEL_SIZE: usize = 1_000;

/// Settings for `PayloadDispatcher`
#[derive(Debug)]
pub struct PayloadDispatcherSettings {
    // settings needed for the protocol-specific adapter
    pub chain_conf: ChainConf,
    /// settings needed for chain-specific adapter
    pub raw_chain_conf: RawChainConf,
    pub domain: HyperlaneDomain,
    pub db: DatabaseOrPath,
    pub metrics: Arc<CoreMetrics>,
}

#[derive(Debug)]
pub enum DatabaseOrPath {
    Database(DB),
    Path(PathBuf),
}

pub struct PayloadDispatcher {
    pub(crate) inner: PayloadDispatcherState,
}

impl PayloadDispatcher {
    pub fn try_from_settings(settings: PayloadDispatcherSettings) -> Result<Self> {
        Ok(Self {
            inner: PayloadDispatcherState::try_from_settings(settings)?,
        })
    }

    pub async fn spawn(self) -> JoinHandle<()> {
        let mut tasks = vec![];
        let building_stage_queue: BuildingStageQueue = Arc::new(Mutex::new(VecDeque::new()));
        let (inclusion_stage_sender, inclusion_stage_receiver) =
            tokio::sync::mpsc::channel::<Transaction>(SUBMITTER_CHANNEL_SIZE);
        let (finality_stage_sender, finality_stage_receiver) =
            tokio::sync::mpsc::channel::<Transaction>(SUBMITTER_CHANNEL_SIZE);

        let building_stage = BuildingStage::new(
            building_stage_queue.clone(),
            inclusion_stage_sender.clone(),
            self.inner.clone(),
        );
        let building_task = tokio::spawn(
            async move {
                building_stage.run().await;
            }
            .instrument(tracing::info_span!("building_stage")),
        );
        tasks.push(building_task);

        let inclusion_stage = InclusionStage::new(
            inclusion_stage_receiver,
            finality_stage_sender.clone(),
            self.inner.clone(),
        );
        let inclusion_task = tokio::spawn(
            async move {
                inclusion_stage.run().await;
            }
            .instrument(tracing::info_span!("inclusion_stage")),
        );
        tasks.push(inclusion_task);

        let finality_state = FinalityStage::new(
            finality_stage_receiver,
            building_stage_queue.clone(),
            self.inner.clone(),
        );
        let finality_task = tokio::spawn(
            async move {
                finality_state.run().await;
            }
            .instrument(tracing::info_span!("finality_stage")),
        );
        tasks.push(finality_task);

        let payload_db_loader =
            PayloadDbLoader::new(self.inner.payload_db.clone(), building_stage_queue.clone());
        let mut payload_iterator = payload_db_loader.into_iterator().await;
        let payload_loader_task = tokio::spawn(
            async move {
                payload_iterator
                    .load_from_db()
                    .await
                    .expect("Payload loader crashed");
            }
            .instrument(tracing::info_span!("payload_db_loader")),
        );
        tasks.push(payload_loader_task);

        let transaction_db_loader = TransactionDbLoader::new(
            self.inner.tx_db.clone(),
            inclusion_stage_sender.clone(),
            finality_stage_sender.clone(),
        );
        let mut transaction_iterator = transaction_db_loader.into_iterator().await;
        let transaction_loader_task = tokio::spawn(
            async move {
                transaction_iterator
                    .load_from_db()
                    .await
                    .expect("Transaction loader crashed");
            }
            .instrument(tracing::info_span!("transaction_db_loader")),
        );
        tasks.push(transaction_loader_task);

        tokio::spawn(
            async move {
                join_all(tasks).await;
            }
            .instrument(tracing::info_span!("payload_dispatcher")),
        )
    }
}
