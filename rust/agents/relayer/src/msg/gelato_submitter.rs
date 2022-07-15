use abacus_base::CoreMetrics;
use abacus_core::Encode;
use abacus_core::{db::AbacusDB, Signers};
use ethers::abi::Token;
use ethers::types::{Address, U256};
use ethers_contract::BaseContract;
use eyre::{bail, Result};
use gelato::chains::Chain;
use gelato::fwd_req_call::{ForwardRequestArgs, PaymentType, NATIVE_FEE_TOKEN_ADDRESS};
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tokio::{sync::mpsc::error::TryRecvError, task::JoinHandle};
use tracing::{info_span, instrument::Instrumented, Instrument};

use super::SubmitMessageArgs;

const DEFAULT_MAX_FEE: u32 = 1_000_000;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    new_messages_receive_channel: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// The domain of the destination chain for messages submitted with this GelatoSubmitter.
    inbox_domain: u32,
    /// Address of the inbox validator manager contract that will be specified
    /// to Gelato in ForwardRequest submissions to process new messages.
    ivm_address: Address,
    /// The BaseContract representing the InboxValidatorManager ABI, used to encode process()
    /// calldata into Gelato ForwardRequest arg.
    ivm_base_contract: BaseContract,
    /// The address of the inbox on the destination chain.
    inbox_address: Address,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    /// TODO(webbhorn): Promote to non-_-prefixed name once we're checking gas payments.
    _db: AbacusDB,
    /// Domain of the outbox.
    outbox_domain: u32,
    /// Signer to use for EIP-712 meta-transaction signatures.
    signer: Signers,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    /// Intended to be shared by reqwest library.
    http: reqwest::Client,
    /// Prometheus metrics.
    /// TODO(webbhorn): Promote to non-_-prefixed name once we're populating metrics.
    _metrics: GelatoSubmitterMetrics,
}

#[allow(clippy::too_many_arguments)]
impl GelatoSubmitter {
    pub fn new(
        new_messages_receive_channel: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_domain: u32,
        ivm_address: abacus_core::Address,
        ivm_base_contract: BaseContract,
        inbox_address: abacus_core::Address,
        db: AbacusDB,
        outbox_domain: u32,
        signer: Signers,
        metrics: GelatoSubmitterMetrics,
    ) -> Self {
        Self {
            new_messages_receive_channel,
            inbox_domain,
            ivm_address: ivm_address.into(),
            ivm_base_contract,
            inbox_address: inbox_address.into(),
            _db: db,
            outbox_domain,
            signer,
            http: reqwest::Client::new(),
            _metrics: metrics,
        }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }

    /// The Gelato relay framework allows us to submit ops in
    /// parallel, subject to certain retry rules. Therefore all we do
    /// here is spin forever asking for work, then spawn the work to
    /// submit to gelato op.
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            sleep(Duration::from_millis(1000)).await;
        }
    }

    async fn tick(&mut self) -> Result<()> {
        // Pull any messages sent by processor over channel.
        loop {
            match self.new_messages_receive_channel.try_recv() {
                Ok(_msg) => {
                    let op = ForwardRequestOp {
                        args: self.make_forward_request_args(_msg)?,
                        opts: ForwardRequestOptions::default(),
                        signer: self.signer.clone(),
                        http: self.http.clone(),
                    };
                    tokio::spawn(async move {
                        op.run()
                            .await
                            .expect("failed unimplemented forward request submit op");
                    });
                }
                Err(TryRecvError::Empty) => {
                    break;
                }
                Err(_) => {
                    bail!("Disconnected receive channel or fatal err");
                }
            }
        }
        Ok(())
    }

    fn make_forward_request_args(&self, _msg: SubmitMessageArgs) -> Result<ForwardRequestArgs> {
        let mut proof: [[u8; 32]; 32] = Default::default();
        proof
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = _msg.proof.path[i].to_fixed_bytes());
        let call_data = self.ivm_base_contract.encode(
            "process",
            [
                Token::Address(self.inbox_address),
                Token::FixedBytes(_msg.checkpoint.checkpoint.root.to_fixed_bytes().into()),
                Token::Uint(_msg.checkpoint.checkpoint.index.into()),
                Token::Array(
                    _msg.checkpoint
                        .signatures
                        .iter()
                        .map(|s| Token::Bytes(s.to_vec()))
                        .collect(),
                ),
                Token::Bytes(_msg.committed_message.message.to_vec()),
                Token::FixedArray(
                    proof
                        .iter()
                        .map(|s| Token::FixedBytes(s.to_vec()))
                        .collect(),
                ),
                Token::Uint(_msg.leaf_index.into()),
            ],
        )?;
        Ok(ForwardRequestArgs {
            target_chain: Chain::from_abacus_domain(self.inbox_domain),
            target_contract: self.ivm_address,
            fee_token: NATIVE_FEE_TOKEN_ADDRESS,
            max_fee: DEFAULT_MAX_FEE.into(),
            gas: DEFAULT_MAX_FEE.into(),
            sponsor_chain_id: Chain::from_abacus_domain(self.outbox_domain),
            payment_type: PaymentType::AsyncGasTank,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            data: call_data,
            // TODO(webbhorn): Use same 'sponsor' address currently
            // being used to sign the directly-submitted ethers
            // transactions right now. We apparently use the same
            // addr for all inbox chains but they could change i
            // guess.
            sponsor: Address::zero(),
        })
    }
}

// TODO(webbhorn): Remove 'allow unused' once we impl run() and ref internal fields.
#[allow(unused)]
#[derive(Debug, Clone)]
pub struct ForwardRequestOp<S> {
    args: ForwardRequestArgs,
    opts: ForwardRequestOptions,
    signer: S,
    http: reqwest::Client,
}

impl<S> ForwardRequestOp<S> {
    async fn run(&self) -> Result<()> {
        todo!()
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

// TODO(webbhorn): Drop allow dead code directive once we handle
// updating each of these metrics.
#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct GelatoSubmitterMetrics {
    run_queue_length_gauge: IntGauge,
    wait_queue_length_gauge: IntGauge,
    queue_duration_hist: Histogram,
    processed_gauge: IntGauge,
    messages_processed_count: IntCounter,
    /// Private state used to update actual metrics each tick.
    max_submitted_leaf_index: u32,
}

impl GelatoSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            run_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                outbox_chain,
                inbox_chain,
                "run_queue",
            ]),
            wait_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                outbox_chain,
                inbox_chain,
                "wait_queue",
            ]),
            queue_duration_hist: metrics
                .submitter_queue_duration_histogram()
                .with_label_values(&[outbox_chain, inbox_chain]),
            messages_processed_count: metrics
                .messages_processed_count()
                .with_label_values(&[outbox_chain, inbox_chain]),
            processed_gauge: metrics.last_known_message_leaf_index().with_label_values(&[
                "message_processed",
                outbox_chain,
                inbox_chain,
            ]),
            max_submitted_leaf_index: 0,
        }
    }
}
