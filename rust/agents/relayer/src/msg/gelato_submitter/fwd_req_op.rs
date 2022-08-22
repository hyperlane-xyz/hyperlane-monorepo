use std::{time::Duration, sync::Arc};

use abacus_base::InboxValidatorManagers;
use abacus_core::InboxValidatorManager;
use ethers::{signers::Signer, types::{U256, Address, H160}};
use eyre::Result;
use gelato::{fwd_req_call::{ForwardRequestArgs, ForwardRequestCall, PaymentType, ForwardRequestCallResult}, chains::Chain, task_status_call::{TaskStatusCall, TaskStatusCallArgs, TaskStatus}};
use tokio::{time::{sleep, timeout}, sync::mpsc::UnboundedSender};

use crate::msg::SubmitMessageArgs;

// TODO(webbhorn): Remove 'allow unused' once we impl run() and ref internal fields.
#[allow(unused)]
#[derive(Debug, Clone)]
pub(crate) struct ForwardRequestOp<S> {
    pub args: ForwardRequestArgs,
    pub opts: ForwardRequestOptions,
    pub signer: S,
    pub http: reqwest::Client,

    submit_msg_args: SubmitMessageArgs,

    inbox_validator_manager: Arc<InboxValidatorManagers>,
    fwd_req_failure_sender: UnboundedSender<SubmitMessageArgs>,
}

impl<S> ForwardRequestOp<S>
where
    S: Signer,
    S::Error: 'static
 {
    #[allow(dead_code)]
    pub async fn new(
        opts: ForwardRequestOptions,
        sponsor_chain: Chain,
        target_chain: Chain,
        inbox_validator_manager: Arc<InboxValidatorManagers>,
        submit_msg_args: SubmitMessageArgs,
        signer: S,
        http: reqwest::Client,
        fwd_req_failure_sender: UnboundedSender<SubmitMessageArgs>,
    ) -> Result<ForwardRequestOp<S>> {
        let args = ForwardRequestOp::<S>::create_forward_request_args(
            sponsor_chain,
            target_chain,
            &inbox_validator_manager,
            &submit_msg_args,
            signer.address(),
        ).await?;

        Ok(
            ForwardRequestOp {
                args,
                opts,
                signer,
                http,
                inbox_validator_manager,
                fwd_req_failure_sender,
                submit_msg_args,
            }
        )
    }

    #[allow(unused)]
    pub async fn run(&self) {
        loop {
            let fwd_req_result = match self.send_forward_request_call().await {
                Ok(fwd_req_result) => fwd_req_result,
                Err(e) => {
                    self.fwd_req_failure_sender.send(self.submit_msg_args.clone()).unwrap();
                    return;
                }
            };

            match timeout(self.opts.retry_submit_interval, self.wait_for_fwd_req_terminal_state(fwd_req_result.task_id)).await {
                Ok(Ok(())) => {
                    // return Ok(());
                },
                Ok(Err(_)) | Err(_) => {
                    // Start loop over
                }
            }
        }
    }

    async fn wait_for_fwd_req_terminal_state(&self, task_id: String) -> Result<()> {
        loop {
            sleep(
                self.opts.poll_interval
            ).await;

            let status_call = TaskStatusCall {
                http: Arc::new(self.http.clone()),
                args: TaskStatusCallArgs {
                    task_id: task_id.clone(),
                }
            };
            let status_result = status_call.run().await?;

            if let [tx_status] = &status_result.data[..] {
                tracing::info!(task_id=?task_id, tx_status=?tx_status, "Got forward request status");

                match tx_status.task_state {
                    TaskStatus::ExecSuccess => return Ok(()),
                    TaskStatus::Cancelled => eyre::bail!("Task canelled"),
                    _ => {}
                }
            } else {
                tracing::warn!(task_id=?task_id, status_result_data=?status_result.data, "Unexpected forward request status data");
            }
        }
    }

    async fn create_forward_request_args(
        sponsor_chain: Chain,
        target_chain: Chain,
        inbox_validator_manager: &Arc<InboxValidatorManagers>,
        submit_msg_args: &SubmitMessageArgs,
        sponsor_address: H160,
    ) -> Result<ForwardRequestArgs> {
        let tx_request = inbox_validator_manager
            .process_tx(
                &submit_msg_args.checkpoint,
                &submit_msg_args.committed_message.message,
                &submit_msg_args.proof,
            )
            .await?;
        
        Ok(ForwardRequestArgs {
            sponsor_chain_id: sponsor_chain,
            chain_id: target_chain,

            target: inbox_validator_manager
                .contract_address()
                .into(),
            data: tx_request.data.unwrap(),
            fee_token: Address::zero(),
            payment_type: PaymentType::AsyncGasTank,
            max_fee: U256::zero(),
            gas: tx_request.gas.unwrap(),
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            sponsor: sponsor_address,
        })
    }

    async fn send_forward_request_call(&self) -> Result<ForwardRequestCallResult> {
        let signature = self.signer.sign_typed_data(&self.args).await?;

        let fwd_req_call = ForwardRequestCall {
            args: self.args.clone(),
            http: self.http.clone(),
            signature,
        };

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
