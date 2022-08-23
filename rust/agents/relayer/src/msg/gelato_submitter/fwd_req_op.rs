use std::{sync::Arc, time::Duration};

use ethers::signers::Signer;
use eyre::Result;
use gelato::{
    fwd_req_call::{ForwardRequestArgs, ForwardRequestCall, ForwardRequestCallResult},
    task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs},
};
use tokio::time::{sleep, timeout};

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
    ) -> ForwardRequestOp<S> {
        tracing::info!(args=?args, opts=?opts, "Creating fwd_req_op");
        ForwardRequestOp {
            args,
            opts,
            signer,
            http,
        }
    }

    #[allow(unused)]
    pub async fn run(&self) {
        tracing::info!("In fwd_req_op run");
        loop {
            let fwd_req_result = match self.send_forward_request_call().await {
                Ok(fwd_req_result) => fwd_req_result,
                Err(err) => {
                    // self.fwd_req_failure_sender.send(self.submit_msg_args.clone()).unwrap();
                    tracing::warn!(err=?err, "Error sending forward_request_call");
                    sleep(self.opts.retry_submit_interval).await;
                    continue;
                }
            };

            tracing::info!(fwd_req_result=?fwd_req_result, "Sent forward request");

            // let fwd_req_result = self.send_forward_request_call().await.unwrap();

            match timeout(
                self.opts.retry_submit_interval,
                self.wait_for_fwd_req_terminal_state(fwd_req_result.task_id.clone()),
            )
            .await
            {
                Ok(Ok(())) => {
                    tracing::info!("successful processing!");
                    return;
                },
                Ok(Err(err)) => {
                    tracing::info!(fwd_req_result=?fwd_req_result, err=?err, "Error sending forward request Ok(Err())");
                },
                Err(err) => {
                    tracing::info!(fwd_req_result=?fwd_req_result, err=?err, "Error sending forward request Err()");
                    // Start loop over
                }
            }
        }
    }

    async fn wait_for_fwd_req_terminal_state(&self, task_id: String) -> Result<()> {
        loop {
            sleep(self.opts.poll_interval).await;

            let status_call = TaskStatusCall {
                http: Arc::new(self.http.clone()),
                args: TaskStatusCallArgs {
                    task_id: task_id.clone(),
                },
            };
            let status_result = status_call.run().await?;

            if let [tx_status] = &status_result.data[..] {
                tracing::info!(task_id=?task_id, tx_status=?tx_status, status_result=?status_result, "Got forward request status");

                match tx_status.task_state {
                    TaskStatus::ExecSuccess => return Ok(()),
                    TaskStatus::Cancelled => eyre::bail!("Task cancelled"),
                    _ => {}
                }
            } else {
                tracing::warn!(task_id=?task_id, status_result_data=?status_result.data, "Unexpected forward request status data");
            }
        }
    }

    // fn create_forward_request_args(
    //     sponsor_chain: Chain,
    //     target_chain: Chain,
    //     inbox_validator_manager: &Arc<InboxValidatorManagers>,
    //     submit_msg_args: &SubmitMessageArgs,
    //     sponsor_address: H160,
    // ) -> Result<ForwardRequestArgs> {
    //     let calldata = inbox_validator_manager
    //         .process_calldata(
    //             &submit_msg_args.checkpoint,
    //             &submit_msg_args.committed_message.message,
    //             &submit_msg_args.proof,
    //         )?;

    //     Ok(ForwardRequestArgs {
    //         sponsor_chain_id: sponsor_chain,
    //         chain_id: target_chain,

    //         target: inbox_validator_manager
    //             .contract_address()
    //             .into(),
    //         data: calldata,
    //         fee_token: Address::zero(),
    //         payment_type: PaymentType::AsyncGasTank,
    //         max_fee: U256::from(DEFAULT_MAX_FEE),
    //         gas: U256::from(DEFAULT_GAS_LIMIT),
    //         nonce: U256::zero(),
    //         enforce_sponsor_nonce: false,
    //         enforce_sponsor_nonce_ordering: false,
    //         sponsor: sponsor_address,
    //     })
    // }

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
