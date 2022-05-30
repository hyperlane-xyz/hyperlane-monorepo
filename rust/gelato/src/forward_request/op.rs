use crate::chains::Chain;
use crate::err::GelatoError;
use crate::forward_request::call::Call;
use crate::task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs};
use ethers::signers::Signer;
use ethers::types::{Address, Bytes, U256};
use tokio::time::Duration;

extern crate num_derive;

use std::sync::Arc;
pub struct Op<S> {
    pub args: OpArgs,
    pub opts: Options,
    pub signer: S,
    pub http: Arc<reqwest::Client>,
    // TODO: tracer?
    // TODO: interface to DB?
    // TODO: prometheus registry?
}

impl<S: Signer> Op<S> {
    pub async fn run(&self) -> Result<OpResult, GelatoError> {
        // Generate signature over args with signer.
        // TODO: handle error.
        let sig = self.signer.sign_typed_data(&self.args).await.unwrap();

        // Submit ForwardRequest to Relay node, retry
        // with exp-backoff-with-limit if retryable
        // error, return err if fatal err.
        let fwd_req_call = Call {
            http: Arc::clone(&self.http),
            args: self.args.clone(),
            sig: sig.clone(),
        };
        let fwd_req_result = fwd_req_call.run().await?;
        dbg!(&fwd_req_result);

        // Periodically poll (with jitter) for task
        // status, retrying the poll endpoint as necessary.
        // If poll results in permanent non-retryable error,
        // return the result.
        loop {
            // TODO(webbhorn): Resubmit the op if 'opts.retry_submit_interval'\
            // has elapsed since initial submission and we have still not
            // seen success or a permanent error.
            let poll_call_args = TaskStatusCallArgs {
                task_id: fwd_req_result.task_id.clone(),
            };
            let poll_call = TaskStatusCall {
                http: Arc::clone(&self.http),
                args: poll_call_args.clone(),
            };
            let result = poll_call.run().await?;
            dbg!(&result);
            // TODO(webbhorn): Check size first...
            if result.data[0].task_state == TaskStatus::ExecSuccess {
                break;
            }
            // TODO(webbhorn): Other non-retryable errors for which we
            // should abort the entire op?
            println!("sleeping for {}s", &self.opts.poll_interval.as_secs());
            tokio::time::sleep(self.opts.poll_interval).await;
        }
        Ok(OpResult {})
    }
}

#[derive(Debug, Clone)]
pub struct OpArgs {
    pub chain_id: Chain,
    pub target: Address,
    pub data: Bytes,
    pub fee_token: Address,
    pub payment_type: PaymentType,
    pub max_fee: U256,
    pub gas: U256,
    pub sponsor: Address,
    pub sponsor_chain_id: Chain,
    pub nonce: U256,
    pub enforce_sponsor_nonce: bool,
    pub enforce_sponsor_nonce_ordering: bool,
}

#[derive(Debug, Clone)]
pub struct OpResult {
    // TODO: lots more here than just task_id,
// including gas charged, block number, etc
// etc etc etc.
}

pub struct Options {
    pub poll_interval: Duration,
    pub retry_submit_interval: Duration,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(60),
            retry_submit_interval: Duration::from_secs(20 * 60),
        }
    }
}

#[repr(u64)]
#[derive(Debug, Clone, FromPrimitive)]
pub enum PaymentType {
    Sync = 0,
    AsyncGasTank = 1,
    SyncGasTank = 2,
    SyncPullFee = 3,
}
