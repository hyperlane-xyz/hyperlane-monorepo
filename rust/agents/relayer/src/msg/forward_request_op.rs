use std::time::{Duration, Instant};

use abacus_core::{CommittedMessage, MessageStatus, Signers};
use ethers::types::U256;
use ethers_signers::Signer;
use eyre::{bail, Result};

use gelato::fwd_req_call::{ForwardRequestArgs, ForwardRequestCall, ForwardRequestCallResult};
use gelato::task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs, TransactionStatus};
use tokio::time::sleep;
use tracing::debug;

use super::{gas_oracle::GasPaymentOracle, message_status::ProcessedStatusOracle};

#[derive(Debug, Clone)]
pub(crate) struct ForwardRequestOp {
    pub(crate) args: ForwardRequestArgs,
    pub(crate) opts: ForwardRequestOptions,
    pub(crate) signer: Signers,
    pub(crate) gas_oracle: GasPaymentOracle,
    pub(crate) status_oracle: ProcessedStatusOracle,
    pub(crate) msg: CommittedMessage,
    pub(crate) http: reqwest::Client,
}

impl ForwardRequestOp {
    pub async fn run(&self) -> Result<ForwardRequestOpResult> {
        loop {
            if self.already_processed().await? {
                return Ok(ForwardRequestOpResult::new_from_processed_observation());
            }
            let gas_paid = self.gas_oracle.get_total_payment(self.msg.leaf_index)?;
            if gas_paid <= self.opts.min_required_gas_payment {
                sleep(self.opts.gas_poll_interval).await;
                continue;
            }
            let fwd_req_result = self.submit_forward_request().await?;
            let start = Instant::now();
            return self
                .poll_task_status(start, fwd_req_result.task_id.as_str())
                .await;
        }
    }
    async fn already_processed(&self) -> Result<bool> {
        if self.status_oracle.message_status(&self.msg).await? == MessageStatus::Processed {
            return Ok(true);
        }
        Ok(false)
    }
    async fn poll_task_status(
        &self,
        start: Instant,
        task_id: &str,
    ) -> Result<ForwardRequestOpResult> {
        loop {
            if start.elapsed() >= self.opts.retry_submit_interval {
                bail!("Forward request expired after {:?}", start.elapsed());
            }
            if self.already_processed().await? {
                return Ok(ForwardRequestOpResult::new_from_processed_observation());
            }
            let status_call = TaskStatusCall {
                http: self.http.clone(),
                args: TaskStatusCallArgs {
                    task_id: task_id.to_string(),
                },
            };
            let result = status_call.run().await?;
            if result.data.len() != 1 {
                bail!("Unexpected Gelato task data: {:?}", result);
            }
            let task_state = result.data[0].task_state.clone();
            debug!(?task_state, ?self.msg, ?result, "Gelato status");
            match task_state {
                TaskStatus::ExecSuccess => {
                    return Ok(ForwardRequestOpResult::new_from_gelato_success(
                        result.data[0].clone(),
                    ));
                }
                TaskStatus::ExecReverted
                | TaskStatus::Cancelled
                | TaskStatus::Blacklisted
                | TaskStatus::NotFound => {
                    bail!("Gelato non-retryable task failure: {:?}", task_state);
                }
                TaskStatus::CheckPending
                | TaskStatus::ExecPending
                | TaskStatus::WaitingForConfirmation => {
                    sleep(self.opts.poll_interval).await;
                    continue;
                }
            }
        }
    }
    async fn submit_forward_request(&self) -> Result<ForwardRequestCallResult> {
        let fwd_req_call = ForwardRequestCall {
            http: self.http.clone(),
            args: &self.args,
            sig: self.signer.sign_typed_data(&self.args).await?,
        };
        Ok(fwd_req_call.run().await?)
    }
    pub(crate) fn get_message(&self) -> &CommittedMessage {
        &self.msg
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ForwardRequestOpResult {
    pub(crate) message_status: MessageStatus,
    pub(crate) responsible_for_processing: bool,
    pub(crate) txn_status: Option<TransactionStatus>,
}

impl ForwardRequestOpResult {
    fn new_from_processed_observation() -> Self {
        Self {
            message_status: MessageStatus::Processed,
            responsible_for_processing: false,
            txn_status: None,
        }
    }
    fn new_from_gelato_success(txn_status: TransactionStatus) -> Self {
        Self {
            message_status: MessageStatus::Processed,
            responsible_for_processing: true,
            txn_status: Some(txn_status),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ForwardRequestOptions {
    poll_interval: Duration,
    gas_poll_interval: Duration,
    retry_submit_interval: Duration,
    min_required_gas_payment: U256,
}

impl Default for ForwardRequestOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(60),
            gas_poll_interval: Duration::from_secs(20),
            retry_submit_interval: Duration::from_secs(20 * 60),
            min_required_gas_payment: U256::zero(),
        }
    }
}
