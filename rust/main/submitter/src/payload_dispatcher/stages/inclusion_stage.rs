// // TODO: re-enable clippy warnings
// #![allow(dead_code)]

// use std::{collections::VecDeque, sync::Arc};

// use derive_new::new;
// use eyre::Result;
// use futures_util::future::try_join_all;
// use tokio::{
//     sync::{mpsc, Mutex},
//     time::sleep,
// };
// use tracing::{error, info};

// use crate::{
//     payload::FullPayload,
//     transaction::{Transaction, TransactionStatus},
// };

// use super::PayloadDispatcherState;

// pub type InclusionStagePool = Arc<Mutex<VecDeque<Transaction>>>;

// #[derive(new)]
// struct InclusionStage {
//     pool: InclusionStagePool,
//     building_stage_receiver: mpsc::Receiver<Transaction>,
//     finality_stage_sender: mpsc::Sender<Transaction>,
//     state: PayloadDispatcherState,
// }

// impl InclusionStage {
//     pub async fn run(&self) -> Result<()> {
//         let futures = vec![self.receive_txs(), self.process_txs()];
//         if let Err(err) = try_join_all(futures).await {
//             error!(
//                 error=?err,
//                 "Inclusion stage future panicked"
//             );
//         }
//     }

//     async fn receive_txs(&mut self) -> Result<()> {
//         loop {
//             let tx = self.building_stage_receiver.recv().await.unwrap();
//             self.pool.lock().await.push_back(tx);
//         }
//     }

//     // - Event-driven by new blocks being produced, rather than by queue
//     //     - New blocks are polled, likely at an interval of `max(block_time, 30s)` to avoid chains with very low blocktimes (like the 400ms on solana)
//     // - The pool is iterated
//     // - txs are checked for inclusion by calling `tx_status(transaction)`
//     // - txs that aren’t included AND newly received are simulated before submitting using `simulate_tx(tx)` on the ChainTxAdapter, and dropped if failing
//     // - `submit` is called on each tx, if they were not yet included in a block
//     // - reverted txs and their payload(s) are dropped
//     // - txs are sent to the Finality Stage if included in a block
//     // - the statuses of txs and payloads are updated in the db. The `nonce` → `tx_uuid` store is updated as well
//     // - submission errors are assumed to be network related, so txs are retried an indefinite number of times.
//     //     - Open question: should we cap the number of retries? But if RPCs go down for 12h we may end up with all Payloads dropped from the Dispatcher. We’ll likely learn the answer as we operate this
//     // - If a transaction is dropped, updates the Transaction and Payload stores and the `payload_id` → `tx_uuid` mapping
//     async fn process_txs(&self) -> Result<()> {
//         let estimated_block_time = self.state.adapter.estimated_block_time().await?;
//         loop {
//             // evaluate the pool every block
//             sleep(estimated_block_time).await;

//             let pool_snapshot = self.pool.lock().await.clone();
//             for tx in pool_snapshot {
//                 let tx_status = self.state.adapter.tx_status(&tx).await?;
//                 if matches!(tx_status, TransactionStatus::Included) {
//                     // update tx status in db
//                     self.update_tx_status(&mut tx, tx_status).await?;
//                     self.finality_stage_sender.send(tx).await?;
//                     continue;
//                 }
//                 if tx.submission_attempts() == 0 {
//                     // simulate tx
//                     let success = self.state.adapter.simulate_tx(&tx).await?;
//                     if !success {
//                         continue;
//                     }
//                 }
//                 let simulated = self.state.adapter.simulate_tx(&tx).await?;
//                 if simulated {
//                     self.state.adapter.submit(&mut tx).await?;
//                 }
//             }
//         }
//     }

//     async fn drop_tx(&self, tx: &mut Transaction) -> Result<()> {
//         info!(?tx, "Dropping tx");
//         self.update_tx_status(tx, TransactionStatus::DroppedByChain)
//             .await?;

//         Ok(())
//     }

//     async fn update_tx_status(
//         &self,
//         tx: &mut Transaction,
//         new_status: TransactionStatus,
//     ) -> Result<()> {
//         info!(?tx, ?new_status, "Updating tx status");
//         tx.set_status(new_status);
//         self.state.tx_db.store_transaction_by_id(tx).await?;
//         Ok(())
//     }
// }
