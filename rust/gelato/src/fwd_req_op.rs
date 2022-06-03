use crate::chains::Chain;
use crate::err::GelatoError;
use crate::fwd_req_call::ForwardRequestCall;
use crate::task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs};
use ethers::signers::Signer;
use ethers::types::{Address, Bytes, U256};
use std::sync::Arc;
use tokio::time::Duration;
use tracing::{info, instrument};

extern crate num_derive;

#[derive(Debug, Clone)]
pub struct ForwardRequestOpArgs {
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
pub struct ForwardRequestOpResult {
    // TODO: lots more here than just task_id,
// including gas charged, block number, etc
// etc etc etc.
}

#[derive(Debug, Clone)]
pub struct ForwardRequestOptions {
    pub poll_interval: Duration,
    pub retry_submit_interval: Duration,
}

// TODO(webbhorn): Support cancel() on an in-flight
// ForwardRequestOp from some task other than the one
// currently inside of op.run(), e.g. by using a
// tokio_util::sync::CancellationToken
// (https://docs.rs/tokio-util/latest/tokio_util/sync/struct.CancellationToken.html)
// that is private to the Op struct and signalled via a
// call to op.cancel().
//
// TODO(webbhorn): ... And/Or, support injection of a
// RetryPolicy closure in construction of the Op that
// we can specifically use to query the shared Inbox
// state to e.g. find out if a message has already
// been delivered (perhaps by some other Relayer), and
// we should stop retrying and return from run().
//
// TODO(webbhorn): Maybe take deps on traits
// instead of concrete types, e.g. for 'http'.
#[derive(Debug, Clone)]
pub struct ForwardRequestOp<S> {
    pub args: ForwardRequestOpArgs,
    pub opts: ForwardRequestOptions,
    pub signer: S,
    pub http: Arc<reqwest::Client>,
    // TODO: tracer?
    // TODO: interface to DB?
    // TODO: prometheus registry?
}

impl<S: Signer> ForwardRequestOp<S> {
    #[instrument]
    pub async fn run(&self) -> Result<ForwardRequestOpResult, GelatoError> {
        // TODO(webbhorn): handle signing error. Presumably for AWS
        // some are retryable, others not?
        let sig = self.signer.sign_typed_data(&self.args).await.unwrap();
        loop {
            let fwd_req_call = ForwardRequestCall {
                http: Arc::clone(&self.http),
                args: self.args.clone(),
                sig: sig.clone(),
            };
            // TODO(webbhorn): If retryable error, retry submitting
            // request after backoff if retryable (via 'continue;').
            let fwd_req_result = fwd_req_call.run().await?;
            info!(?fwd_req_result);

            // Poll for task status every opts.poll_interval,
            // waiting for any of:
            //     1.  task status to be ExecSuccess, return Ok(..)
            //     2.  task status to be a permanent, non-retryable
            //         error, return GelatoError:: ...
            //     3.  20m (aka `self.opts.retry_submit_interval`)
            //         to have elapsed, in which case re-enter
            //         outer loop..
            //     4.  A transient, OK state, or temporary error,
            //         in which case, re-enter the top of the inner
            //         retry loop.
            for attempt in 0.. {
                info!(?attempt);
                // TODO(webbhorn): Resubmit the op if
                // 'opts.retry_submit_interval' has elapsed since
                // initial submission and we have still not seen
                // success or a permanent error.
                let poll_call_args = TaskStatusCallArgs {
                    task_id: fwd_req_result.task_id.clone(),
                };
                let poll_call = TaskStatusCall {
                    http: Arc::clone(&self.http),
                    args: poll_call_args.clone(),
                };
                let result = poll_call.run().await?;
                info!("{:#?}", result);
                // TODO(webbhorn): Check size of result.data first...
                if result.data[0].task_state == TaskStatus::ExecSuccess {
                    // TODO(webbhorn): Return actual data...
                    return Ok(ForwardRequestOpResult {});
                }
                // TODO(webbhorn): Other non-retryable errors for
                // which we should abort the entire op?
                info!(
                    "will retry polling for task status in {}s",
                    &self.opts.poll_interval.as_secs()
                );
                tokio::time::sleep(self.opts.poll_interval).await;
            }
        }
    }
}

impl Default for ForwardRequestOptions {
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
