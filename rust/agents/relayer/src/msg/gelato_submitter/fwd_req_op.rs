use std::time::Duration;

use ethers::signers::Signer;
use eyre::Result;
use gelato::fwd_req_call::{ForwardRequestArgs, ForwardRequestCall};

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
    S::Error: 'static
 {
    #[allow(unused)]
    pub async fn run(&self) -> Result<()> {
        loop {
            let fwd_req_call = self.create_forward_request_call();
        }
    }

    async fn create_forward_request_call(&self) -> Result<ForwardRequestCall> {
        let signature = self.signer.sign_typed_data(&self.args).await?;
        Ok(
            ForwardRequestCall {
                args: self.args.clone(),
                http: self.http.clone(),
                signature,
            }
        )
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
