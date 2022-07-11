use crate::err::GelatoError;
use crate::fwd_req_call::{ForwardRequestArgs, ForwardRequestCall};
use crate::task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs};
use ethers::signers::Signer;
use std::sync::Arc;
use tokio::time::Duration;
use tracing::{debug, info, instrument};

#[derive(Debug, Clone)]
pub struct ForwardRequestOpResult {
    // TODO: lots more here than just task_id, including gas charged,
    // block number, etc etc etc etc.
}

#[derive(Debug, Clone)]
pub struct ForwardRequestOptions {
    pub poll_interval: Duration,
    pub retry_submit_interval: Duration,
}

#[derive(Debug, Clone)]
pub struct ForwardRequestOp<S> {
    pub args: ForwardRequestArgs,
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
        // TODO(webbhorn): handle signing error. Presumably for AWS some are retryable, others not?
        let sig = self.signer.sign_typed_data(&self.args).await.unwrap();
        loop {
            let fwd_req_call = ForwardRequestCall {
                http: Arc::clone(&self.http),
                args: self.args.clone(),
                sig: sig.clone(),
            };
            // TODO(webbhorn): If retryable error, retry submitting request after backoff if
            // retryable (via 'continue;').
            let fwd_req_result = fwd_req_call.run().await?;
            info!(?fwd_req_result);

            // Poll for task status every opts.poll_interval, waiting for any of:
            // 1.  task status to be ExecSuccess, return Ok(..).
            // 2.  task status to be a . permanent, non-retryable error, return a GelatoError.
            // 3.  20m (aka `self.opts.retry_submit_interval`) to have elapsed, in which case
            //     re-enter outer loop.
            // 4.  A transient, OK state, or temporary error, in which case, re-enter the top of
            //     the inner retry loop.
            for attempt in 0.. {
                info!(?attempt);
                // TODO(webbhorn): Resubmit the op if 'opts.retry_submit_interval' has elapsed since
                // initial submission and we have still not seen success or a permanent error.
                let poll_call_args = TaskStatusCallArgs {
                    task_id: fwd_req_result.task_id.clone(),
                };
                let poll_call = TaskStatusCall {
                    http: Arc::clone(&self.http),
                    args: poll_call_args.clone(),
                };
                let result = poll_call.run().await?;
                debug!("{:#?}", result);
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
