use std::{sync::Arc, time::Duration};

use abacus_base::InboxContracts;
use abacus_core::{ChainCommunicationError, Inbox, InboxValidatorManager, MessageStatus};
use ethers::{
    signers::Signer,
    types::{H160, U256},
};
use eyre::Result;
use gelato::{
    chains::Chain,
    fwd_req_call::{
        ForwardRequestArgs, ForwardRequestCall, ForwardRequestCallResult, PaymentType,
        NATIVE_FEE_TOKEN_ADDRESS,
    },
    task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs},
};
use tokio::{
    sync::mpsc::UnboundedSender,
    time::{sleep, timeout},
};

use crate::msg::SubmitMessageArgs;

/// The max fee to use for Gelato ForwardRequests.
/// Gelato isn't charging fees on testnet. For now, use this hardcoded value
/// of 1e18, or 1.0 ether.
/// TODO: revisit when testing on mainnet and actually considering interchain
/// gas payments.
const DEFAULT_MAX_FEE: u64 = 10u64.pow(18);

/// The default gas limit to use for Gelato ForwardRequests, arbitrarily chose
/// to be 5M.
/// TODO: once Gelato fully deploys their new version, simply omit the gas
/// limit so that Gelato does the estimation for us.
const DEFAULT_GAS_LIMIT: u64 = 5000000;

#[derive(Debug, Clone)]
pub(crate) struct ForwardRequestOp<S> {
    opts: ForwardRequestOptions,
    http: reqwest::Client,

    message: SubmitMessageArgs,
    inbox_contracts: InboxContracts,
    sponsor_signer: S,
    sponsor_address: H160,
    // Currently unused due to a bug in Gelato's testnet relayer that is currently being upgraded.
    _sponsor_chain: Chain,
    destination_chain: Chain,

    /// A channel to send the message over upon the message being successfully processed.
    message_processed_sender: UnboundedSender<SubmitMessageArgs>,
}

impl<S> ForwardRequestOp<S>
where
    S: Signer,
    S::Error: 'static,
{
    pub fn new(
        opts: ForwardRequestOptions,
        http: reqwest::Client,
        message: SubmitMessageArgs,
        inbox_contracts: InboxContracts,
        sponsor_signer: S,
        sponsor_address: H160,
        sponsor_chain: Chain,
        destination_chain: Chain,
        message_processed_sender: UnboundedSender<SubmitMessageArgs>,
    ) -> ForwardRequestOp<S> {
        ForwardRequestOp {
            opts,
            http,
            message,
            inbox_contracts,
            sponsor_signer,
            sponsor_address,
            _sponsor_chain: sponsor_chain,
            destination_chain,
            message_processed_sender,
        }
    }

    pub async fn run(&self) {
        loop {
            match self.tick().await {
                Ok(MessageStatus::Processed) => {
                    // If the message was processed, send it over the channel and
                    // stop running.
                    if let Err(err) = self.send_message_processed() {
                        tracing::error!(err=?err, "Unable to send processed message, receiver is closed or dropped.");
                    }
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
            return Ok(MessageStatus::Processed);
        }

        // Send the forward request.
        let fwd_req_result = self.send_forward_request_call().await?;
        tracing::info!(task_id=?fwd_req_result.task_id, "Sent forward request");

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
                tracing::info!(task_id=?task_id, tx_status=?tx_status, "Polled forward request status");

                match tx_status.task_state {
                    TaskStatus::Cancelled => return Ok(MessageStatus::None),
                    _ => {}
                }
            } else {
                tracing::warn!(task_id=?task_id, status_result_data=?status_result.data, "Unexpected forward request status data");
            }
        }
    }

    // Once gas payments are enforced, we will likely fetch the gas payment from
    // the DB here. This is why forward request args are created and signed for each
    // forward request call.
    async fn send_forward_request_call(&self) -> Result<ForwardRequestCallResult> {
        let args = self.create_forward_request_args();
        let signature = self.sponsor_signer.sign_typed_data(&args).await?;

        let fwd_req_call = ForwardRequestCall {
            args,
            http: self.http.clone(),
            signature,
        };

        Ok(fwd_req_call.run().await?)
    }

    fn create_forward_request_args(&self) -> ForwardRequestArgs {
        let calldata = self.inbox_contracts.validator_manager.process_calldata(
            &self.message.checkpoint,
            &self.message.committed_message.message,
            &self.message.proof,
        );
        ForwardRequestArgs {
            chain_id: self.destination_chain,
            target: self
                .inbox_contracts
                .validator_manager
                .contract_address()
                .into(),
            data: calldata.into(),
            fee_token: NATIVE_FEE_TOKEN_ADDRESS,
            payment_type: PaymentType::AsyncGasTank,
            max_fee: DEFAULT_MAX_FEE.into(),
            gas: DEFAULT_GAS_LIMIT.into(),
            // At the moment, there's a bug with Gelato where environments that don't charge
            // fees (i.e. testnet) require the sponsor chain ID to be the same as the chain
            // in which the tx will be sent to.
            // This will be fixed in an upcoming release they're doing.
            sponsor_chain_id: self.destination_chain,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            sponsor: self.sponsor_address,
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
