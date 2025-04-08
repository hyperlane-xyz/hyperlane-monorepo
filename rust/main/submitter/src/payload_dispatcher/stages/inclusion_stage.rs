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
use tracing::{error, info, info_span, Instrument};

use crate::{
    error::SubmitterError,
    payload::{FullPayload, PayloadStatus},
    payload_dispatcher::stages::utils::update_tx_status,
    transaction::{DropReason as TxDropReason, Transaction, TransactionId, TransactionStatus},
};

use super::{utils::retry_until_success, PayloadDispatcherState};

pub type InclusionStagePool = Arc<Mutex<HashMap<TransactionId, Transaction>>>;

#[derive(new)]
struct InclusionStage {
    pool: InclusionStagePool,
    tx_receiver: mpsc::Receiver<Transaction>,
    finality_stage_sender: mpsc::Sender<Transaction>,
    state: PayloadDispatcherState,
}

impl InclusionStage {
    pub async fn run(self) {
        let InclusionStage {
            pool,
            tx_receiver,
            finality_stage_sender,
            state,
        } = self;
        let futures = vec![
            tokio::spawn(
                Self::receive_txs(tx_receiver, pool.clone()).instrument(info_span!("receive_txs")),
            ),
            tokio::spawn(
                Self::process_txs(pool, finality_stage_sender, state)
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
    ) -> Result<(), SubmitterError> {
        loop {
            if let Some(tx) = building_stage_receiver.recv().await {
                pool.lock().await.insert(tx.id.clone(), tx.clone());
                info!(?tx, "Received transaction");
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
    ) -> Result<(), SubmitterError> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            // evaluate the pool every block
            sleep(*estimated_block_time).await;

            let pool_snapshot = pool.lock().await.clone();
            for (_, tx) in pool_snapshot {
                if let Err(err) =
                    Self::try_process_tx(tx.clone(), &finality_stage_sender, &state, &pool).await
                {
                    error!(?err, ?tx, "Error processing transaction. Skipping for now");
                }
            }
        }
    }

    async fn try_process_tx(
        mut tx: Transaction,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &PayloadDispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        let tx_status = retry_until_success(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
        )
        .await;

        match tx_status {
            TransactionStatus::PendingInclusion | TransactionStatus::Mempool => {
                info!(tx_id = ?tx.id, ?tx_status, "Transaction is pending inclusion");
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

    async fn process_pending_tx(
        mut tx: Transaction,
        state: &PayloadDispatcherState,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        let simulation_success =
            retry_until_success(|| state.adapter.simulate_tx(&tx), "Simulating transaction").await;
        if !simulation_success {
            Self::drop_tx(state, &mut tx, TxDropReason::FailedSimulation, pool).await?;
            return Err(eyre!("Transaction simulation failed"));
        }

        // successively calling `submit` will result in escalating gas price until the tx is accepted
        // by the node.
        // at this point, not all VMs return information about whether the tx was reverted.
        // so dropping reverted payloads has to happen in the finality step
        retry_until_success(
            || {
                let tx_clone = tx.clone();
                async move {
                    let mut tx_clone_inner = tx_clone.clone();
                    state.adapter.submit(&mut tx_clone_inner).await
                }
            },
            "Submitting transaction",
        )
        .await;

        // update tx submission attempts
        tx.submission_attempts += 1;
        // update tx status in db
        update_tx_status(state, &mut tx, TransactionStatus::Mempool).await?;
        pool.lock().await.remove(&tx.id);
        Ok(())
    }

    async fn drop_tx(
        state: &PayloadDispatcherState,
        tx: &mut Transaction,
        reason: TxDropReason,
        pool: &InclusionStagePool,
    ) -> Result<()> {
        info!(?tx, "Dropping tx");
        let new_tx_status = TransactionStatus::Dropped(reason);
        update_tx_status(state, tx, new_tx_status.clone()).await?;
        // drop the payloads as well
        state
            .update_status_for_payloads(
                &tx.payload_details,
                PayloadStatus::InTransaction(new_tx_status),
            )
            .await;
        pool.lock().await.remove(&tx.id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        payload_dispatcher::{
            test_utils::{
                create_random_txs_and_store_them, dummy_tx, initialize_payload_db, tmp_dbs,
                MockAdapter,
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
        assert_txs_not_in_db(txs_created.clone(), &pool).await;
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

        mock_adapter.expect_submit().returning(|_| Ok(()));

        let (txs_created, txs_received, tx_db, payload_db, pool) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

        assert_eq!(txs_received.len(), 0);
        assert_txs_not_in_db(txs_created.clone(), &pool).await;
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

        let (txs_created, txs_received, tx_db, payload_db, pool) =
            set_up_test_and_run_stage(mock_adapter, TXS_TO_PROCESS).await;

        assert_eq!(txs_received.len(), 0);
        assert_txs_not_in_db(txs_created.clone(), &pool).await;
        assert_tx_status(
            txs_received.clone(),
            &tx_db,
            &payload_db,
            TransactionStatus::Dropped(TxDropReason::FailedSimulation),
        )
        .await;
    }

    async fn assert_txs_not_in_db(txs: Vec<Transaction>, pool: &InclusionStagePool) {
        let pool = pool.lock().await;
        for tx in txs.iter() {
            assert!(pool.get(&tx.id).is_none());
        }
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

        let state =
            PayloadDispatcherState::new(payload_db.clone(), tx_db.clone(), Arc::new(mock_adapter));
        let pool = Arc::new(Mutex::new(HashMap::new()));
        let inclusion_stage = InclusionStage::new(
            pool.clone(),
            building_stage_receiver,
            finality_stage_sender,
            state,
        );

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
