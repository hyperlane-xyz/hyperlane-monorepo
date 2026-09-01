// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, path::PathBuf, sync::Arc};

use derive_new::new;
use eyre::Result;
use futures_util::future::join_all;
use tokio::{sync::Mutex, task::JoinHandle};

use hyperlane_base::{
    db::{HyperlaneRocksDB, DB},
    settings::{ChainConf, RawChainConf},
    CoreMetrics,
};
use hyperlane_core::HyperlaneDomain;
use tracing::{instrument, Instrument};

use crate::{
    adapter::{AdapterFactory, AdaptsChain},
    dispatcher::{BuildingStage, FinalityStage, InclusionStage, PayloadDbLoader},
    transaction::Transaction,
};

use super::{
    entrypoint::DispatcherEntrypoint, metrics::DispatcherMetrics, DispatcherState,
    TransactionDbLoader,
};

const SUBMITTER_CHANNEL_SIZE: usize = 1_000;

/// Settings for `PayloadDispatcher`
#[derive(Clone, Debug)]
pub struct DispatcherSettings {
    // settings needed for the protocol-specific adapter
    pub chain_conf: ChainConf,
    /// settings needed for chain-specific adapter
    pub raw_chain_conf: RawChainConf,
    pub domain: HyperlaneDomain,
    pub db: DatabaseOrPath,
    pub metrics: Arc<CoreMetrics>,
}

#[derive(Clone, Debug)]
pub enum DatabaseOrPath {
    Database(DB),
    Path(PathBuf),
}

#[derive(Clone)]
pub struct Dispatcher {
    pub(crate) inner: DispatcherState,
    /// the name of the destination chain
    /// used for logging
    pub(crate) domain: String,
}

impl Dispatcher {
    pub async fn try_from_settings(
        settings: DispatcherSettings,
        domain: String,
        metrics: DispatcherMetrics,
    ) -> Result<(DispatcherEntrypoint, Self)> {
        let state = DispatcherState::try_from_settings(settings, metrics).await?;
        Ok(Self::from_state_with_entrypoint(state, domain))
    }

    fn from_state_with_entrypoint(
        state: DispatcherState,
        domain: String,
    ) -> (DispatcherEntrypoint, Self) {
        let entrypoint = DispatcherEntrypoint::from_inner(state.clone());
        let dispatcher = Self {
            inner: state,
            domain,
        };
        (entrypoint, dispatcher)
    }

    /// Create a Dispatcher from a DispatcherState and domain (for testing)
    #[cfg(feature = "integration_test")]
    pub fn from_inner(inner: DispatcherState, domain: String) -> Self {
        Self { inner, domain }
    }

    #[instrument(skip(self), fields(domain = %self.domain))]
    pub fn spawn(self) -> JoinHandle<()> {
        let domain = self.domain.clone();
        tokio::task::Builder::new()
            .name("dispatcher")
            .spawn(
                async move {
                    self.run().await;
                }
                .instrument(tracing::info_span!("dispatcher", %domain)),
            )
            .expect("spawning tokio task from Builder is infallible")
    }

    async fn run(self) {
        let mut tasks = vec![];
        let building_stage_queue = self.inner.building_stage_queue.clone();
        let (inclusion_stage_sender, inclusion_stage_receiver) =
            tokio::sync::mpsc::channel::<Transaction>(SUBMITTER_CHANNEL_SIZE);
        let (finality_stage_sender, finality_stage_receiver) =
            tokio::sync::mpsc::channel::<Transaction>(SUBMITTER_CHANNEL_SIZE);

        let inclusion_stage = InclusionStage::new(
            inclusion_stage_receiver,
            finality_stage_sender.clone(),
            self.inner.clone(),
            self.domain.clone(),
        );
        let inclusion_task = tokio::task::Builder::new()
            .name("inclusion_stage")
            .spawn(
                async move {
                    inclusion_stage.run().await;
                }
                .instrument(tracing::info_span!("inclusion_stage")),
            )
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(inclusion_task);

        let finality_stage = FinalityStage::new(
            finality_stage_receiver,
            building_stage_queue.clone(),
            self.inner.clone(),
            self.domain.clone(),
        );
        let finality_task = tokio::task::Builder::new()
            .name("finality_stage")
            .spawn(
                async move {
                    finality_stage.run().await;
                }
                .instrument(tracing::info_span!("finality_stage")),
            )
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(finality_task);

        let transaction_db_loader = TransactionDbLoader::new(
            self.inner.tx_db.clone(),
            inclusion_stage_sender.clone(),
            finality_stage_sender.clone(),
            self.domain.clone(),
        );
        let mut transaction_iterator = transaction_db_loader.into_iterator().await;
        let metrics = self.inner.metrics.clone();
        let transaction_loader_task = tokio::task::Builder::new()
            .name("transaction_loader")
            .spawn(
                async move {
                    transaction_iterator
                        .load_from_db(metrics)
                        .await
                        .expect("Transaction loader crashed");
                }
                .instrument(tracing::info_span!("transaction_db_loader")),
            )
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(transaction_loader_task);

        // Transaction recovery and its consumers remain live while the derived
        // payload index is rebuilt. New ingress and the building consumer stay
        // gated so reconciliation cannot race a payload into a second transaction.
        PayloadDbLoader::new(
            self.inner.payload_db.clone(),
            building_stage_queue,
            self.domain.clone(),
        )
        .load_from_db(self.inner.metrics.clone())
        .await
        .expect("Payload loader crashed");

        let building_stage = BuildingStage::new(
            self.inner.building_stage_queue.clone(),
            inclusion_stage_sender,
            self.inner.clone(),
            self.domain.clone(),
        );
        let building_task = tokio::task::Builder::new()
            .name("building_stage")
            .spawn(
                async move {
                    building_stage.run().await;
                }
                .instrument(tracing::info_span!("building_stage")),
            )
            .expect("spawning tokio task from Builder is infallible");
        tasks.push(building_task);
        self.inner.mark_recovery_complete();

        join_all(tasks).await;
    }
}

#[cfg(test)]
mod shared_state_tests {
    use std::sync::Arc;

    use super::Dispatcher;
    use crate::{
        dispatcher::{DispatcherMetrics, DispatcherState},
        tests::test_utils::{tmp_dbs, MockAdapter},
    };

    #[test]
    fn entrypoint_and_dispatcher_share_state() {
        let (payload_db, tx_db, _) = tmp_dbs();
        let adapter = Arc::new(MockAdapter::new());
        let state = DispatcherState::new(
            payload_db,
            tx_db,
            adapter,
            DispatcherMetrics::dummy_instance(),
            "test".to_string(),
        );

        let (entrypoint, dispatcher) =
            Dispatcher::from_state_with_entrypoint(state, "test".to_string());

        assert!(Arc::ptr_eq(
            &entrypoint.inner.adapter,
            &dispatcher.inner.adapter
        ));
        assert!(Arc::ptr_eq(
            &entrypoint.inner.payload_db,
            &dispatcher.inner.payload_db
        ));
        assert!(Arc::ptr_eq(
            &entrypoint.inner.tx_db,
            &dispatcher.inner.tx_db
        ));
    }
}
