use std::{ops::Deref, sync::Arc, time::Duration};

use abacus_base::InboxContracts;
use abacus_core::{ChainCommunicationError, Inbox, InboxValidatorManager, MessageStatus};
use eyre::Result;
use gelato::{
    sponsored_call::{SponsoredCallApiCall, SponsoredCallApiCallResult, SponsoredCallArgs},
    task_status::{TaskState, TaskStatusApiCall, TaskStatusApiCallArgs},
    types::Chain,
};
use tokio::{
    sync::mpsc::UnboundedSender,
    time::{sleep, timeout},
};
use tracing::instrument;

use crate::msg::{gas_payment::GasPaymentEnforcer, SubmitMessageArgs};

// The number of seconds after a tick to sleep before attempting the next tick.
const TICK_SLEEP_DURATION_SECONDS: u64 = 30;

#[derive(Debug, Clone)]
pub struct SponsoredCallOpArgs {
    pub opts: SponsoredCallOptions,
    pub http: reqwest::Client,

    pub message: SubmitMessageArgs,
    pub inbox_contracts: InboxContracts,
    pub sponsor_api_key: String,
    pub destination_chain: Chain,

    pub gas_payment_enforcer: Arc<GasPaymentEnforcer>,

    /// A channel to send the message over upon the message being successfully processed.
    pub message_processed_sender: UnboundedSender<SubmitMessageArgs>,
}

#[derive(Debug, Clone)]
pub struct SponsoredCallOp(SponsoredCallOpArgs);

impl Deref for SponsoredCallOp {
    type Target = SponsoredCallOpArgs;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl SponsoredCallOp {
    pub fn new(args: SponsoredCallOpArgs) -> Self {
        Self(args)
    }

    #[instrument(skip(self), fields(msg_leaf_index=self.0.message.leaf_index))]
    pub async fn run(&mut self) {
        loop {
            match self.tick().await {
                Ok(MessageStatus::Processed) => {
                    // If the message was processed, send it over the channel and
                    // stop running.
                    if let Err(err) = self.send_message_processed() {
                        tracing::error!(
                            err=?err,
                            "Unable to send processed message, receiver is closed or dropped.",
                        );
                    }
                    return;
                }
                Err(err) => {
                    tracing::warn!(
                        err=?err,
                        "Error occurred in sponsored_call_op tick",
                    );
                }
                _ => {}
            }

            self.0.message.num_retries += 1;
            sleep(Duration::from_secs(TICK_SLEEP_DURATION_SECONDS)).await;
        }
    }

    /// One tick will submit a sponsored call to Gelato and wait for a terminal state
    /// or timeout.
    async fn tick(&self) -> Result<MessageStatus> {
        // Before doing anything, first check if the message has already been processed.
        if let Ok(MessageStatus::Processed) = self.message_status().await {
            return Ok(MessageStatus::Processed);
        }

        let tx_estimated_cost = self
            .0
            .inbox_contracts
            .validator_manager
            .process_estimate_costs(
                &self.0.message.checkpoint,
                &self.0.message.committed_message.message,
                &self.0.message.proof,
            )
            .await?;

        // If the gas payment requirement hasn't been met, sleep briefly and wait for the next tick.
        let (meets_gas_requirement, gas_payment) = self
            .gas_payment_enforcer
            .message_meets_gas_payment_requirement(
                &self.0.message.committed_message,
                &tx_estimated_cost,
            )
            .await?;

        if !meets_gas_requirement {
            tracing::info!(gas_payment=?gas_payment, "Gas payment requirement not met yet");
            return Ok(MessageStatus::None);
        }

        // Send the sponsored call.
        let sponsored_call_result = self.send_sponsored_call_api_call().await?;
        tracing::info!(
            msg=?self.0.message,
            task_id=sponsored_call_result.task_id,
            "Sent sponsored call",
        );

        // Wait for a terminal state, timing out according to the retry_submit_interval.
        match timeout(
            self.0.opts.retry_submit_interval,
            self.poll_for_terminal_state(sponsored_call_result.task_id.clone()),
        )
        .await
        {
            Ok(result) => {
                // Bubble up any error that may have occurred in `poll_for_terminal_state`.
                result
            }
            // If a timeout occurred, don't bubble up an error, instead just log
            // and set ourselves up for the next tick.
            Err(err) => {
                tracing::info!(err=?err, "Sponsored call timed out, reattempting");
                Ok(MessageStatus::None)
            }
        }
    }

    // Waits until the message has either been processed or the task id has been cancelled
    // by Gelato.
    async fn poll_for_terminal_state(&self, task_id: String) -> Result<MessageStatus> {
        loop {
            sleep(self.0.opts.poll_interval).await;

            // Check if the message has been processed. Checking with the Inbox directly
            // is the best source of truth, and is the only way in which a message can be
            // marked as processed.
            if let Ok(MessageStatus::Processed) = self.message_status().await {
                return Ok(MessageStatus::Processed);
            }

            // Get the status of the SponsoredCall task from Gelato for debugging.
            // If the task was cancelled for some reason by Gelato, stop waiting.

            let task_status_api_call = TaskStatusApiCall {
                http: self.0.http.clone(),
                args: TaskStatusApiCallArgs {
                    task_id: task_id.clone(),
                },
            };
            let task_status_result = task_status_api_call.run().await?;
            let task_state = task_status_result.task_state();

            tracing::info!(
                task_id=task_id,
                task_state=?task_state,
                task_status_result=?task_status_result,
                "Polled sponsored call status",
            );

            // The only terminal state status is if the task was cancelled, which happens after
            // Gelato has reached the max # of retries for a task. Currently, the default is
            // after about 30 seconds.
            if let TaskState::Cancelled = task_state {
                return Ok(MessageStatus::None);
            }
        }
    }

    // Once gas payments are enforced, we will likely fetch the gas payment from
    // the DB here. This is why sponsored call args are created and signed for each
    // sponsored call call.
    async fn send_sponsored_call_api_call(&self) -> Result<SponsoredCallApiCallResult> {
        let args = self.create_sponsored_call_args();

        let sponsored_call_api_call = SponsoredCallApiCall {
            args: &args,
            http: self.0.http.clone(),
            sponsor_api_key: &self.sponsor_api_key,
        };

        Ok(sponsored_call_api_call.run().await?)
    }

    fn create_sponsored_call_args(&self) -> SponsoredCallArgs {
        let calldata = self.0.inbox_contracts.validator_manager.process_calldata(
            &self.0.message.checkpoint,
            &self.0.message.committed_message.message,
            &self.0.message.proof,
        );
        SponsoredCallArgs {
            chain_id: self.0.destination_chain,
            target: self
                .inbox_contracts
                .validator_manager
                .contract_address()
                .into(),
            data: calldata.into(),
            gas_limit: None, // Gelato will handle gas estimation
            retries: None,   // Use Gelato's default of 5 retries, each ~5 seconds apart
        }
    }

    async fn message_status(&self) -> Result<MessageStatus, ChainCommunicationError> {
        self.inbox_contracts
            .inbox
            .message_status(self.message.committed_message.to_leaf())
            .await
    }

    fn send_message_processed(
        &self,
    ) -> Result<(), tokio::sync::mpsc::error::SendError<SubmitMessageArgs>> {
        self.message_processed_sender.send(self.message.clone())
    }
}

#[derive(Debug, Clone)]
pub struct SponsoredCallOptions {
    pub poll_interval: Duration,
    pub retry_submit_interval: Duration,
}

impl Default for SponsoredCallOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(20),
            retry_submit_interval: Duration::from_secs(60),
        }
    }
}
