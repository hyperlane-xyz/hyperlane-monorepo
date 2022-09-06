use std::{ops::Deref, sync::Arc, time::Duration};

use abacus_base::InboxContracts;
use abacus_core::{ChainCommunicationError, Inbox, InboxValidatorManager, MessageStatus};
use ethers::{signers::Signer, types::H160};
use eyre::Result;
use gelato::{
    chains::Chain,
    fwd_req_call::{ForwardRequestArgs, ForwardRequestCall, ForwardRequestCallResult},
    task_status_call::{TaskState, TaskStatusCall, TaskStatusCallArgs},
};
use tokio::{
    sync::mpsc::UnboundedSender,
    time::{sleep, timeout},
};
use tracing::instrument;

use crate::msg::SubmitMessageArgs;

const SPONSOR_API_KEY: &str = "foobar";

#[derive(Debug, Clone)]
pub struct ForwardRequestOpArgs<S> {
    pub opts: ForwardRequestOptions,
    pub http: reqwest::Client,

    pub message: SubmitMessageArgs,
    pub inbox_contracts: InboxContracts,
    pub sponsor_signer: S,
    pub sponsor_address: H160,
    // Currently unused due to a bug in Gelato's testnet relayer that is currently being upgraded.
    pub sponsor_chain: Chain,
    pub destination_chain: Chain,

    /// A channel to send the message over upon the message being successfully processed.
    pub message_processed_sender: UnboundedSender<SubmitMessageArgs>,
}

#[derive(Debug, Clone)]
pub struct ForwardRequestOp<S>(ForwardRequestOpArgs<S>);

impl<S> Deref for ForwardRequestOp<S> {
    type Target = ForwardRequestOpArgs<S>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<S> ForwardRequestOp<S>
where
    S: Signer,
    S::Error: 'static,
{
    pub fn new(args: ForwardRequestOpArgs<S>) -> Self {
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
                        "Error occurred in fwd_req_op tick",
                    );
                }
                _ => {}
            }

            self.0.message.num_retries += 1;
            sleep(Duration::from_secs(5)).await;
        }
    }

    async fn tick(&self) -> Result<MessageStatus> {
        // Before doing anything, first check if the message has already been processed.
        if let Ok(MessageStatus::Processed) = self.message_status().await {
            return Ok(MessageStatus::Processed);
        }

        // Send the forward request.
        let fwd_req_result = self.send_forward_request_call().await?;
        tracing::info!(
            msg=?self.0.message,
            task_id=fwd_req_result.task_id,
            "Sent forward request",
        );

        // Wait for a terminal state, timing out according to the retry_submit_interval.
        match timeout(
            self.0.opts.retry_submit_interval,
            self.poll_for_terminal_state(fwd_req_result.task_id.clone()),
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
                tracing::debug!(err=?err, "Forward request timed out, reattempting");
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

            // Get the status of the ForwardRequest task from Gelato for debugging.
            // If the task was cancelled for some reason by Gelato, stop waiting.

            let task_status_call = TaskStatusCall {
                http: Arc::new(self.0.http.clone()),
                args: TaskStatusCallArgs {
                    task_id: task_id.clone(),
                },
            };
            let task_status_result = task_status_call.run().await?;
            let task_state = task_status_result.task_state();

            tracing::info!(
                task_id=task_id,
                task_state=?task_state,
                task_status_result=?task_status_result,
                "Polled forward request status",
            );

            // The only terminal state status is if the task was cancelled, which happens after
            // Gelato has known about the task for ~20 minutes and could not execute it.
            if let TaskState::Cancelled = task_state {
                return Ok(MessageStatus::None);
            }
        }
    }

    // Once gas payments are enforced, we will likely fetch the gas payment from
    // the DB here. This is why forward request args are created and signed for each
    // forward request call.
    async fn send_forward_request_call(&self) -> Result<ForwardRequestCallResult> {
        let args = self.create_forward_request_args();
        // let signature = self.0.sponsor_signer.sign_typed_data(&args).await?;

        let fwd_req_call = ForwardRequestCall {
            args,
            http: self.0.http.clone(),
            sponsor_api_key: SPONSOR_API_KEY.into(),
        };

        Ok(fwd_req_call.run().await?)
    }

    fn create_forward_request_args(&self) -> ForwardRequestArgs {
        let calldata = self.0.inbox_contracts.validator_manager.process_calldata(
            &self.0.message.checkpoint,
            &self.0.message.committed_message.message,
            &self.0.message.proof,
        );
        ForwardRequestArgs {
            chain_id: self.0.destination_chain,
            target: self
                .inbox_contracts
                .validator_manager
                .contract_address()
                .into(),
            data: calldata.into(),
            gas_limit: None,
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
pub struct ForwardRequestOptions {
    pub poll_interval: Duration,
    pub retry_submit_interval: Duration,
}

impl Default for ForwardRequestOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(60),
            retry_submit_interval: Duration::from_secs(20 * 60),
        }
    }
}
