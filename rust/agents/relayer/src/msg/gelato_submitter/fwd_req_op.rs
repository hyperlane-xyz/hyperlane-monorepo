use std::{sync::Arc, time::Duration};

use abacus_base::CachingInbox;
use abacus_core::{ChainCommunicationError, Inbox, MessageStatus};
use ethers::signers::Signer;
use eyre::Result;
use gelato::{
    fwd_req_call::{ForwardRequestArgs, ForwardRequestCall, ForwardRequestCallResult},
    task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs},
};
use tokio::{
    sync::mpsc::UnboundedSender,
    time::{sleep, timeout},
};

use crate::msg::SubmitMessageArgs;

// /// The max fee to use for Gelato ForwardRequests.
// /// Gelato isn't charging fees on testnet. For now, use this hardcoded value
// /// of 1e18, or 1.0 ether.
// /// TODO: revisit when testing on mainnet and actually considering interchain
// /// gas payments.
// const DEFAULT_MAX_FEE: u64 = 1000000000000000000;

// /// The default gas limit to use for Gelato ForwardRequests.
// /// TODO: instead estimate gas for messages.
// const DEFAULT_GAS_LIMIT: u64 = 3000000;

// TODO(webbhorn): Remove 'allow unused' once we impl run() and ref internal fields.
#[allow(unused)]
#[derive(Debug, Clone)]
pub(crate) struct ForwardRequestOp<S> {
    pub args: ForwardRequestArgs,
    pub opts: ForwardRequestOptions,
    pub signer: S,
    pub http: reqwest::Client,

    pub message: SubmitMessageArgs,
    pub inbox: Arc<CachingInbox>,

    message_processed_sender: UnboundedSender<SubmitMessageArgs>,
}

impl<S> ForwardRequestOp<S>
where
    S: Signer,
    S::Error: 'static,
{
    #[allow(dead_code)]
    pub fn new(
        opts: ForwardRequestOptions,
        args: ForwardRequestArgs,
        signer: S,
        http: reqwest::Client,
        message: SubmitMessageArgs,
        inbox: Arc<CachingInbox>,

        message_processed_sender: UnboundedSender<SubmitMessageArgs>,
    ) -> ForwardRequestOp<S> {
        tracing::info!(args=?args, opts=?opts, "Creating fwd_req_op");
        ForwardRequestOp {
            args,
            opts,
            signer,
            http,
            message,
            inbox,
            message_processed_sender,
        }
    }

    #[allow(unused)]
    pub async fn run(&self) {
        tracing::info!("In fwd_req_op run");

        loop {
            match self.tick().await {
                Ok(MessageStatus::Processed) => {
                    // If the message was processed, send it over the channel and
                    // stop running.
                    self.send_message_processed();
                    return;
                }
                Err(err) => {
                    tracing::warn!(err=?err, "Error occurred in fwd_req_op tick");
                }
                _ => {}
            }

            sleep(Duration::from_secs(5)).await;
        }
    }

    async fn tick(&self) -> Result<MessageStatus> {
        // Before doing anything, first check if the message has already been processed.
        if let Ok(MessageStatus::Processed) = self.message_status().await {
            tracing::debug!("Polled inbox and message was processed already");
            return Ok(MessageStatus::Processed);
        }

        // Send the forward request.
        let fwd_req_result = self.send_forward_request_call().await?;
        tracing::info!(fwd_req_result=?fwd_req_result, "Sent forward request");

        // Wait for a terminal state, timing out according to the retry_submit_interval.
        match timeout(
            self.opts.retry_submit_interval,
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
            sleep(self.opts.poll_interval).await;

            // Check if the message has been processed. Checking with the Inbox directly
            // is the best source of truth, and is the only way in which a message can be
            // marked as processed.
            if let Ok(MessageStatus::Processed) = self.message_status().await {
                return Ok(MessageStatus::Processed);
            }

            // Get the status of the ForwardRequest task from Gelato for debugging.
            // If the task was cancelled for some reason by Gelato, stop waiting.

            let status_call = TaskStatusCall {
                http: Arc::new(self.http.clone()),
                args: TaskStatusCallArgs {
                    task_id: task_id.clone(),
                },
            };
            let status_result = status_call.run().await?;

            if let [tx_status] = &status_result.data[..] {
                tracing::info!(task_id=?task_id, tx_status=?tx_status, "Got forward request status");

                match tx_status.task_state {
                    // TaskStatus::ExecSuccess => return Ok(MessageStatus::Processed),
                    TaskStatus::Cancelled => return Ok(MessageStatus::None),
                    _ => {}
                }
            } else {
                tracing::warn!(task_id=?task_id, status_result_data=?status_result.data, "Unexpected forward request status data");
            }
        }
    }

    async fn send_forward_request_call(&self) -> Result<ForwardRequestCallResult> {
        tracing::info!("About to sign send_forward_request_call...");
        let signature = self.signer.sign_typed_data(&self.args).await?;
        tracing::info!(signature=?signature, "Signed send_forward_request_call");

        let fwd_req_call = ForwardRequestCall {
            args: self.args.clone(),
            http: self.http.clone(),
            signature,
        };

        tracing::info!(fwd_req_call=?fwd_req_call, "About to run fwd_req_call");

        Ok(fwd_req_call.run().await?)
    }

    async fn message_status(&self) -> Result<MessageStatus, ChainCommunicationError> {
        self.inbox
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
