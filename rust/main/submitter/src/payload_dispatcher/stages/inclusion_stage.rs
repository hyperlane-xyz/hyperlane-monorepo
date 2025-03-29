// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::VecDeque, future::Future, sync::Arc, time::Duration};

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
    transaction::{DropReason as TxDropReason, Transaction, TransactionStatus},
};

use super::{utils::retry_until_success, PayloadDispatcherState};

pub type InclusionStagePool = Arc<Mutex<VecDeque<Transaction>>>;

#[derive(new)]
struct InclusionStage {
    pool: InclusionStagePool,
    building_stage_receiver: mpsc::Receiver<Transaction>,
    finality_stage_sender: mpsc::Sender<Transaction>,
    state: PayloadDispatcherState,
}

impl InclusionStage {
    pub async fn run(&'static mut self) {
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
        building_stage_receiver: &mut mpsc::Receiver<Transaction>,
        pool: InclusionStagePool,
    ) -> Result<()> {
        loop {
            let tx = building_stage_receiver.recv().await.unwrap();
            pool.lock().await.push_back(tx);
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
        pool: &InclusionStagePool,
        finality_stage_sender: &mpsc::Sender<Transaction>,
        state: &PayloadDispatcherState,
    ) -> Result<()> {
        let estimated_block_time = state.adapter.estimated_block_time();
        loop {
            // evaluate the pool every block
            sleep(estimated_block_time).await;

            let pool_snapshot = pool.lock().await.clone();
            for tx in pool_snapshot {
                if let Err(err) =
                    Self::try_process_tx(tx.clone(), finality_stage_sender, state).await
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
