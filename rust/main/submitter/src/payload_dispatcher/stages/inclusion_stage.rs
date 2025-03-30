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
    payload::{FullPayload, PayloadStatus},
    transaction::{DropReason as TxDropReason, Transaction, TransactionId, TransactionStatus},
};

use super::{utils::retry_until_success, PayloadDispatcherState};

pub type InclusionStagePool = Arc<Mutex<HashMap<TransactionId, Transaction>>>;

#[derive(new)]
struct InclusionStage {
    pool: InclusionStagePool,
    building_stage_receiver: mpsc::Receiver<Transaction>,
    finality_stage_sender: mpsc::Sender<Transaction>,
    state: PayloadDispatcherState,
}

impl InclusionStage {
    pub async fn run(self) {
        let InclusionStage {
            pool,
            building_stage_receiver,
            finality_stage_sender,
            state,
        } = self;
        let futures = vec![
            tokio::spawn(
                Self::receive_txs(building_stage_receiver, pool.clone())
                    .instrument(info_span!("receive_txs")),
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
    ) -> Result<()> {
        loop {
            let tx = building_stage_receiver.recv().await.unwrap();
            pool.lock().await.insert(tx.id.clone(), tx.clone());
            info!(?tx, "Received transaction");
        }
    }

    // - Event-driven by new blocks being produced, rather than by queue
    //     - New blocks are polled, likely at an interval of `max(block_time, 30s)` to avoid chains with very low blocktimes (like the 400ms on solana)
    // - The pool is iterated
    // - txs are checked for inclusion by calling `tx_status(transaction)`
    // - txs that aren’t included AND newly received are simulated before submitting using `simulate_tx(tx)` on the ChainTxAdapter, and dropped if failing
    // - `submit` is called on each tx, if they were not yet included in a block
    // - reverted txs and their payload(s) are dropped
    // - txs are sent to the Finality Stage if included in a block
    // - the statuses of txs and payloads are updated in the db. The `nonce` → `tx_uuid` store is updated as well
    // - submission errors are assumed to be network related, so txs are retried an indefinite number of times.
    //     - Open question: should we cap the number of retries? But if RPCs go down for 12h we may end up with all Payloads dropped from the Dispatcher. We’ll likely learn the answer as we operate this
    // - If a transaction is dropped, updates the Transaction and Payload
    async fn process_txs(
        pool: InclusionStagePool,
        finality_stage_sender: mpsc::Sender<Transaction>,
        state: PayloadDispatcherState,
    ) -> Result<()> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            // evaluate the pool every block
            sleep(estimated_block_time).await;

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
        // - txs are checked for inclusion by calling `tx_status(transaction)`
        // - txs that aren’t included AND newly received are simulated before submitting using `simulate_tx(tx)` on the ChainTxAdapter, and dropped if failing
        // - `submit` is called on each tx, if they were not yet included in a block
        // - reverted txs and their payload(s) are dropped
        // - txs are sent to the Finality Stage if included in a block
        // - the statuses of txs and payloads are updated in the db. The `nonce` → `tx_uuid` store is updated as well
        // - submission errors are assumed to be network related, so txs are retried an indefinite number of times.
        //     - Open question: should we cap the number of retries? But if RPCs go down for 12h we may end up with all Payloads dropped from the Dispatcher. We’ll likely learn the answer as we operate this
        // - If a transaction is dropped, updates the Transaction and Payload
        let tx_status = retry_until_success(
            || state.adapter.tx_status(&tx),
            "Querying transaction status",
        )
        .await;

        if matches!(tx_status, TransactionStatus::Included) {
            // update tx status in db
            Self::update_tx_status(state, &mut tx, tx_status).await?;
            let tx_id = tx.id.clone();
            finality_stage_sender.send(tx).await?;
            info!(?tx_id, "Transaction included in block");
            pool.lock().await.remove(&tx_id);
            return Ok(());
        }
        let simulation_success =
            retry_until_success(|| state.adapter.simulate_tx(&tx), "Simulating transaction").await;
        if !simulation_success {
            Self::drop_tx(state, &mut tx, TxDropReason::FailedSimulation).await?;
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
        Self::update_tx_status(state, &mut tx, TransactionStatus::Mempool).await?;

        Ok(())
    }

    async fn drop_tx(
        state: &PayloadDispatcherState,
        tx: &mut Transaction,
        reason: TxDropReason,
    ) -> Result<()> {
        info!(?tx, "Dropping tx");
        let new_tx_status = TransactionStatus::Dropped(reason);
        Self::update_tx_status(state, tx, new_tx_status.clone()).await?;
        // drop the payloads as well
        state
            .update_status_for_payloads(
                &tx.payload_details,
                PayloadStatus::InTransaction(new_tx_status),
            )
            .await;
        Ok(())
    }

    async fn update_tx_status(
        state: &PayloadDispatcherState,
        tx: &mut Transaction,
        new_status: TransactionStatus,
    ) -> Result<()> {
        info!(?tx, ?new_status, "Updating tx status");
        tx.status = new_status;
        state.tx_db.store_transaction_by_id(tx).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        payload::PayloadId,
        payload_dispatcher::test_utils::tests::{dummy_tx, random_txs, tmp_dbs, MockAdapter},
        transaction::{Transaction, TransactionId},
    };
    use eyre::Result;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn test_channel_txs_are_pushed_to_pool() {
        const TXS_TO_PUSH: usize = 3;
        let (sender, mut receiver) = mpsc::channel(TXS_TO_PUSH);
        let pool = Arc::new(Mutex::new(HashMap::new()));

        let random_txs = random_txs(TXS_TO_PUSH);
        for tx in random_txs.iter() {
            sender.send(tx.clone()).await.unwrap();
        }
        tokio::select! {
            _ = InclusionStage::receive_txs(receiver, pool.clone()) => {
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
        for tx in random_txs.iter() {
            let pool = pool.lock().await;
            let transaction = pool.get(&tx.id).unwrap();
            assert_eq!(transaction.id, tx.id);
        }
    }

    #[tokio::test]
    async fn test_processing_txs() {
        const TXS_TO_PROCESS: usize = 3;

        // create inclusion stage
        let (payload_db, tx_db) = tmp_dbs();
        let (building_stage_sender, building_stage_receiver) = mpsc::channel(TXS_TO_PROCESS);
        let (finality_stage_sender, mut finality_stage_receiver) = mpsc::channel(TXS_TO_PROCESS);
        let mock_adapter = MockAdapter::new();
        let state = PayloadDispatcherState::new(payload_db, tx_db, Box::new(mock_adapter));
        let pool = Arc::new(Mutex::new(HashMap::new()));
        let mut inclusion_stage = InclusionStage::new(
            pool.clone(),
            building_stage_receiver,
            finality_stage_sender,
            state,
        );

        // create txs to process
        let random_txs = random_txs(TXS_TO_PROCESS);
        for tx in random_txs.iter() {
            building_stage_sender.send(tx.clone()).await.unwrap();
        }
        let txs_received = run_stage(
            TXS_TO_PROCESS,
            inclusion_stage,
            &mut finality_stage_receiver,
        )
        .await;
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
}
