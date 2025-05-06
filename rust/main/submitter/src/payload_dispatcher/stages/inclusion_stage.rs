// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    sync::Arc,
    time::Duration,
};

use derive_new::new;
use eyre::{eyre, Result};
use futures_util::future::try_join_all;
use tokio::{
    sync::{mpsc, Mutex},
    time::sleep,
};
use tracing::{error, info, info_span, instrument, warn, Instrument};

use crate::{
    error::SubmitterError,
    payload::{FullPayload, PayloadStatus},
    payload_dispatcher::stages::utils::update_tx_status,
    transaction::{DropReason as TxDropReason, Transaction, TransactionId, TransactionStatus},
};

use super::{utils::call_until_success_or_nonretryable_error, PayloadDispatcherState};

pub type InclusionStagePool = Arc<Mutex<HashMap<TransactionId, Transaction>>>;

pub const STAGE_NAME: &str = "InclusionStage";

pub struct InclusionStage {
    pub(crate) pool: InclusionStagePool,
    tx_receiver: mpsc::Receiver<Transaction>,
    finality_stage_sender: mpsc::Sender<Transaction>,
    state: PayloadDispatcherState,
    domain: String,
}

impl InclusionStage {
    pub fn new(
        tx_receiver: mpsc::Receiver<Transaction>,
        finality_stage_sender: mpsc::Sender<Transaction>,
        state: PayloadDispatcherState,
        domain: String,
    ) -> Self {
        Self {
            pool: Arc::new(Mutex::new(HashMap::new())),
            tx_receiver,
            finality_stage_sender,
            state,
            domain,
        }
    }

    pub async fn run(self) {
        let InclusionStage {
            pool,
            tx_receiver,
            finality_stage_sender,
            state,
            domain,
        } = self;
        let futures = vec![
            tokio::spawn(
                Self::receive_txs(tx_receiver, pool.clone(), state.clone(), domain.clone())
                    .instrument(info_span!("receive_txs")),
            ),
            tokio::spawn(
                Self::process_txs(pool, finality_stage_sender, state, domain)
                    .instrument(info_span!("process_txs")),
            ),
        ];
        if let Err(err) = try_join_all(futures).await {
            error!(
                error=?err,
                "Inclusion stage future panicked"
            );
        }
    }

    async fn receive_txs(
        mut building_stage_receiver: mpsc::Receiver<Transaction>,
        pool: InclusionStagePool,
        state: PayloadDispatcherState,
        domain: String,
    ) -> Result<(), SubmitterError> {
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{}::receive_txs", STAGE_NAME).as_str(), &domain);
            if let Some(tx) = building_stage_receiver.recv().await {
                // the lock is held until the metric is updated, to prevent race conditions
                let mut pool_lock = pool.lock().await;
                let pool_len = pool_lock.len();
                pool_lock.insert(tx.id.clone(), tx.clone());
                info!(?tx, "Received transaction");
                state
                    .metrics
                    .update_queue_length_metric(STAGE_NAME, pool_len as u64, &domain);
            } else {
                error!("Building stage channel closed");
                return Err(SubmitterError::ChannelClosed);
            }
        }
    }

    async fn process_txs(
        pool: InclusionStagePool,
        finality_stage_sender: mpsc::Sender<Transaction>,
        state: PayloadDispatcherState,
        domain: String,
    ) -> Result<(), SubmitterError> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            state
                .metrics
                .update_liveness_metric(format!("{}::process_txs", STAGE_NAME).as_str(), &domain);
            // evaluate the pool every block
            sleep(*estimated_block_time).await;

            let pool_snapshot = {
                let pool_snapshot = pool.lock().await.clone();
                state.metrics.update_queue_length_metric(
                    STAGE_NAME,
                    pool_snapshot.len() as u64,
                    &domain,
                );
                pool_snapshot
            };
            info!(pool_size=?pool_snapshot.len() , "Processing transactions in inclusion pool");
            for (_, mut tx) in pool_snapshot {
                if let Err(err) =
                    Self::try_process_tx(tx.clone(), &finality_stage_sender, &state, &pool).await
                {
                    error!(?err, ?tx, "Error processing transaction. Dropping it");
                    Self::drop_tx(&state, &mut tx, TxDropReason::FailedSimulation, &pool).await?;
                }
            }
        }
    }

    #[instrument(
        skip_all,
        name = "InclusionStage::try_process_tx",
        fields(tx_id = ?tx.id, tx_status = ?tx.status, payloads = ?tx.payload_details)
    )]
    async fn try_process_tx(
        mut tx: Transaction,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &PayloadDispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        info!(?tx, "Processing inclusion stage transaction");
        let tx_status = call_until_success_or_nonretryable_error(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
            state,
        )
        .await?;
        info!(?tx, ?tx_status, "Transaction status");

        match tx_status {
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                info!(tx_id = ?tx.id, ?tx_status, "Transaction is pending inclusion");
                if !state.adapter.tx_ready_for_resubmission(&tx).await {
                    info!(?tx, "Transaction is not ready for resubmission");
                    return Ok(());
                }
                return Self::process_pending_tx(tx, state, pool).await;
            }
            TransactionStatus::Included | TransactionStatus::Finalized => {
                update_tx_status(state, &mut tx, tx_status.clone()).await?;
                let tx_id = tx.id.clone();
                finality_stage_sender.send(tx).await?;
                info!(?tx_id, ?tx_status, "Transaction included in block");
                pool.lock().await.remove(&tx_id);
                return Ok(());
            }
            TransactionStatus::Dropped(_) => {
                error!(
                    ?tx,
                    ?tx_status,
                    "Transaction has invalid status for inclusion stage"
                );
            }
        }

        Ok(())
    }

    #[instrument(skip_all, name = "InclusionStage::process_pending_tx")]
    async fn process_pending_tx(
        mut tx: Transaction,
        state: &PayloadDispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        info!(?tx, "Processing pending transaction");
        // TODO: simulating the transaction is commented out for now, because
        // on SVM the tx is simulated in the `submit` call.
        // let simulation_success = call_until_success_or_nonretryable_error(
        //     || state.adapter.simulate_tx(&tx),
        //     "Simulating transaction",
        //     state,
        // )
        // .await
        // // if simulation fails or hits a non-retryable error, drop the tx
        // .unwrap_or(false);
        // if !simulation_success {
        //     warn!(?tx, "Transaction simulation failed");
        //     return Err(eyre!("Transaction simulation failed"));
        // }
        // info!(?tx, "Transaction simulation succeeded");

        // Estimating transaction just before we submit it
        // TODO we will need to re-classify `ChainCommunicationError` into `SubmitterError::EstimateError` in the future.
        // At the moment, both errors are non-retryable, so we can keep them as is.
        tx = call_until_success_or_nonretryable_error(
            || {
                let tx_clone = tx.clone();
                async move {
                    let mut tx_clone_inner = tx_clone.clone();
                    state.adapter.estimate_tx(&mut tx_clone_inner).await?;
                    Ok(tx_clone_inner)
                }
            },
            "Simulating and estimating transaction",
            state,
        )
        .await?;

        // successively calling `submit` will result in escalating gas price until the tx is accepted
        // by the node.
        // at this point, not all VMs return information about whether the tx was reverted.
        // so dropping reverted payloads has to happen in the finality step
        tx = call_until_success_or_nonretryable_error(
            || {
                let tx_clone = tx.clone();
                async move {
                    let mut tx_clone_inner = tx_clone.clone();
                    state.adapter.submit(&mut tx_clone_inner).await?;
                    Ok(tx_clone_inner)
                }
            },
            "Submitting transaction",
            state,
        )
        .await?;
        info!(?tx, "Transaction submitted to node");

        // update tx submission attempts
        tx.submission_attempts += 1;
        state
            .metrics
            .update_transaction_submissions_metric(&state.domain);
        // update tx status in db
        update_tx_status(state, &mut tx, TransactionStatus::Mempool).await?;

        // update the pool entry of this tx, to reflect any changes such as the gas price, hash, etc
        pool.lock().await.insert(tx.id.clone(), tx.clone());
        Ok(())
    }

    async fn drop_tx(
        state: &PayloadDispatcherState,
        tx: &mut Transaction,
        reason: TxDropReason,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        warn!(?tx, "Dropping tx");
        let new_tx_status = TransactionStatus::Dropped(reason);
        // this will drop the payloads as well
        update_tx_status(state, tx, new_tx_status.clone()).await?;
        pool.lock().await.remove(&tx.id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        payload_dispatcher::{
            metrics::DispatcherMetrics,
            test_utils::{
                are_all_txs_in_pool, are_no_txs_in_pool, create_random_txs_and_store_them,
                dummy_tx, initialize_payload_db, tmp_dbs, MockAdapter,
            },
            PayloadDb, TransactionDb,
        },
        transaction::{Transaction, TransactionId},
    };
    use eyre::Result;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_processing_included_txs() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::Included));

        let (txs_created, txs_received, tx_db, payload_db, pool) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

        assert_eq!(txs_received.len(), TXS_TO_PROCESS);
        assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Included,
        )
        .await;
    }

    #[tokio::test]
    async fn test_unincluded_txs_reach_mempool() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::PendingInclusion));

        mock_adapter.expect_simulate_tx().returning(|_| Ok(true));

        mock_adapter.expect_estimate_tx().returning(|_| Ok(()));

        mock_adapter.expect_submit().returning(|_| Ok(()));

        let (txs_created, txs_received, tx_db, payload_db, pool) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

        assert_eq!(txs_received.len(), 0);
        assert!(are_all_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Mempool,
        )
        .await;
    }

    #[tokio::test]
    async fn test_failed_simulation() {
        const TXS_TO_PROCESS: usize = 3;

        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimated_block_time()
            .return_const(Duration::from_millis(10));

        mock_adapter
            .expect_tx_status()
            .returning(|_| Ok(TransactionStatus::PendingInclusion));

        mock_adapter.expect_simulate_tx().returning(|_| Ok(false));

        mock_adapter
            .expect_estimate_tx()
            .returning(|_| Err(SubmitterError::SimulationFailed));

        let (txs_created, txs_received, tx_db, payload_db, pool) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

        assert_eq!(txs_received.len(), 0);
        assert!(are_no_txs_in_pool(txs_created.clone(), &pool).await);
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Dropped(TxDropReason::FailedSimulation),
        )
        .await;
    }

    async fn set_up_test_and_run_stage(
        mock_adapter: MockAdapter,
        txs_to_process: usize,
    ) -> (
        Vec<Transaction>,
        Vec<Transaction>,
        Arc<dyn TransactionDb>,
        Arc<dyn PayloadDb>,
        InclusionStagePool,
    ) {
        let (payload_db, tx_db) = tmp_dbs();
        let (building_stage_sender, building_stage_receiver) = mpsc::channel(txs_to_process);
        let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(txs_to_process);

        let state = PayloadDispatcherState::new(
            payload_db.clone(),
            tx_db.clone(),
            Arc::new(mock_adapter),
            DispatcherMetrics::dummy_instance(),
            "test".to_string(),
        );
        let inclusion_stage = InclusionStage::new(
            building_stage_receiver,
            finality_stage_sender,
            state,
            "test".to_string(),
        );
        let pool = inclusion_stage.pool.clone();

        let txs_created = create_random_txs_and_store_them(
            txs_to_process,
            &payload_db,
            &tx_db,
            TransactionStatus::PendingInclusion,
        )
        .await;
        for tx in txs_created.iter() {
            building_stage_sender.send(tx.clone()).await.unwrap();
        }
        let txs_received = run_stage(
            txs_to_process,
            inclusion_stage,
            &mut finality_stage_receiver,
        )
        .await;
        (txs_created, txs_received, tx_db, payload_db, pool)
    }

    async fn run_stage(
        sent_txs_count: usize,
        stage: InclusionStage,
        receiver: &mut tokio::sync::mpsc::Receiver<Transaction>,
    ) -> Vec<Transaction> {
        // future that receives `sent_payload_count` payloads from the building stage
        let receiving_closure = async {
            let mut received = Vec::new();
            while received.len() < sent_txs_count {
                let tx_received = receiver.recv().await.unwrap();
                received.push(tx_received);
            }
            received
        };

        let stage = tokio::spawn(async move { stage.run().await });

        // give the building stage 100ms to send the transaction(s) to the receiver
        let _ = tokio::select! {
            // this arm runs indefinitely
            res = stage => res,
            // this arm runs until all sent payloads are sent as txs
            received = receiving_closure => {
                return received;
            },
            // this arm is the timeout
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(100)) => {
                return vec![]
            },
        };
        vec![]
    }

    async fn assert_tx_status(
        txs: Vec<Transaction>,
        tx_db: &Arc<dyn TransactionDb>,
        payload_db: &Arc<dyn PayloadDb>,
        expected_status: TransactionStatus,
    ) {
        // check that the payload and tx dbs were updated
        for tx in txs {
            let tx_from_db = tx_db
                .retrieve_transaction_by_id(&tx.id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(tx_from_db.status, expected_status.clone());

            for detail in tx.payload_details.iter() {
                let payload = payload_db
                    .retrieve_payload_by_id(&detail.id)
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    payload.status,
                    PayloadStatus::InTransaction(expected_status.clone())
                );
            }
        }
    }
}
