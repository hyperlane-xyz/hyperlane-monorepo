use std::sync::Arc;

use abacus_base::{chains::GelatoConf, CoreMetrics, InboxContracts};
use abacus_core::{db::AbacusDB, Signers};
use abacus_core::{AbacusCommon, Encode};
use ethers::abi::Token;
use ethers::types::Address;
use ethers::types::U256;
use ethers_contract::BaseContract;
use gelato::chains::Chain;
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::{sync::mpsc::error::TryRecvError, task::JoinHandle};

use eyre::{bail, Result};
use tokio::sync::mpsc;
use tracing::{info_span, instrument::Instrumented, Instrument};

use gelato::fwd_req_call::{ForwardRequestArgs, PaymentType};
use gelato::fwd_req_op::{ForwardRequestOp, ForwardRequestOptions};

use super::SubmitMessageArgs;

const DEFAULT_MAX_FEE: u32 = 1_000_000;

#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    new_messages_receive_channel: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// Interface to Inbox / InboxValidatorManager on the destination chain.
    /// Will be useful in retry logic to determine whether or not to re-submit
    /// forward request to Gelato, if e.g. we have confirmation via inbox syncer
    /// that the message has already been submitted by some other relayer.
    inbox_contracts: InboxContracts,
    /// Address of the inbox validator manager contract that will be specified
    /// to Gelato in ForwardRequest submissions to process new messages.
    inbox_validator_manager_address: ethers::types::Address,
    /// The BaseContract representing the InboxValidatorManager ABI, used to encode process()
    /// calldata into Gelato ForwardRequest arg.
    inbox_validator_manager_base_contract: BaseContract,
    /// The address of the inbox on the destination chain.
    inbox_address: Address,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,
    /// Domain of the outbox.
    outbox_domain: u32,
    /// Signer to use for EIP-712 meta-transaction signatures.
    signer: Signers,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    /// Intended to be shared by reqwest library.
    http: Arc<reqwest::Client>,
    /// Prometheus metrics.
    metrics: GelatoSubmitterMetrics,
}

#[allow(clippy::too_many_arguments)]
impl GelatoSubmitter {
    pub fn new(
        cfg: GelatoConf,
        new_messages_receive_channel: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        inbox_validator_manager_address: abacus_core::Address,
        inbox_validator_manager_base_contract: ethers_contract::BaseContract,
        inbox_address: abacus_core::Address,
        db: AbacusDB,
        outbox_domain: u32,
        signer: Signers,
        metrics: GelatoSubmitterMetrics,
    ) -> Self {
        assert!(cfg.enabled_for_message_submission);
        Self {
            new_messages_receive_channel,
            inbox_contracts,
            inbox_validator_manager_address: inbox_validator_manager_address.into(),
            inbox_validator_manager_base_contract,
            inbox_address: inbox_address.into(),
            db,
            outbox_domain,
            signer,
            http: Arc::new(reqwest::Client::new()),
            metrics,
        }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }

    /// The Gelato relay framework allows us to submit ops in
    /// parallel, subject to certain retry rules. Therefore all we do
    /// here is spin forever asking for work from the rx channel, then
    /// spawn the work to submit to gelato in a root tokio task.
    ///
    /// It is possible that there has not been sufficient interchain
    /// gas deposited in the InterchainGasPaymaster account on the source
    /// chain, so we also keep a wait queue of ops that we
    /// periodically scan for any gas updates.
    ///
    /// In the future one could maybe imagine also applying a global
    /// rate-limiter against the relevant Gelato HTTP endpoint or
    /// something, or a max-inflight-cap on Gelato messages from
    /// relayers, enforced here. But probably not until that proves to
    /// be necessary.
    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
        }
    }

    /// Extracted from main loop to enable testing submitter state
    /// after each tick, e.g. in response to a change in environment
    /// conditions like values in InterchainGasPaymaster.
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
                        // TODO(webbhorn): Actually handle errors?
                        op.run().await.unwrap();
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

        let data = self.inbox_validator_manager_base_contract.encode(
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
            target_chain: Chain::from_abacus_domain(self.inbox_contracts.inbox.local_domain()),
            target_contract: self.inbox_validator_manager_address,
            fee_token: gelato::fwd_req_call::NATIVE_FEE_TOKEN_ADDRESS,
            max_fee: DEFAULT_MAX_FEE.into(),
            gas: DEFAULT_MAX_FEE.into(),
            sponsor_chain_id: Chain::from_abacus_domain(self.outbox_domain),
            payment_type: PaymentType::AsyncGasTank,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            data,
            // TODO(webbhorn): Use same 'sponsor' address currently
            // being used to sign the directly-submitted ethers
            // transactions right now. We apparently use the same
            // addr for all inbox chains but they could change i
            // guess.
            sponsor: Address::zero(),
        })
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
