use std::sync::Arc;

use abacus_base::{chains::GelatoConf, CoreMetrics, InboxContracts};
use abacus_core::AbacusCommon;
use abacus_core::{db::AbacusDB, Signers};
use gelato::chains::Chain;
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::{sync::mpsc::error::TryRecvError, task::JoinHandle};

use eyre::{bail, Result};
use tokio::sync::mpsc;
use tracing::{info_span, instrument::Instrumented, Instrument};

use gelato::fwd_req_call::ForwardRequestArgs;
use gelato::fwd_req_op::{ForwardRequestOp, ForwardRequestOptions};

use super::SubmitMessageArgs;

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

impl GelatoSubmitter {
    pub fn new(
        cfg: GelatoConf,
        new_messages_receive_channel: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        db: AbacusDB,
        outbox_domain: u32,
        signer: Signers,
        metrics: GelatoSubmitterMetrics,
    ) -> Self {
        assert!(cfg.enabled_for_message_submission);
        Self {
            new_messages_receive_channel,
            inbox_contracts,
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
                        args: self.make_forward_request_args(_msg),
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
                    bail!("Disconnected rcvq or fatal err");
                }
            }
        }
        Ok(())
    }

    fn make_forward_request_args(&self, _msg: SubmitMessageArgs) -> ForwardRequestArgs {
        //ForwardRequestArgs {
        //    target_chain: target_chain,
        //    target_contract: target_contract,
        //    data,
        //    fee_token,
        //    max_fee,
        //    gas,
        //    sponsor,
        //    sponsor_chain_id,
        //
        //    // For now, Abacus always uses the same values for these fields.
        //    payment_type: PaymentType::AsyncGasTank,
        //    nonce: U256::zero(),
        //    enforce_sponsor_nonce: false,
        //    enforce_sponsor_nonce_ordering: false,
        //}
        ///////////////////////////////////////////////
        ///////////////////////////////////////////////
        ///////////////////////////////////////////////
        //args: ForwardRequestArgs::new(
        //    self.inbox_contracts.inbox.chain_name().parse()?,
        //    // TODO(webbhorn): Somehow get the actual IVM address.
        //    Address::zero(),
        //    // TODO(webbhorn): Somehow marshal process call on IVM into 'data'.
        //    "0x0".parse()?,
        //    // TODO(webbhorn): Somehow plumb source chain token address.
        //    Address::zero(),
        //    // TODO(webbhorn): Pass a non-zero max fee.
        //    U256::zero(),
        //    // TODO(webbhorn): Pass a non-zero gas.
        //    U256::zero(),
        //    // TODO(webbhorn): Pass a non-zero sponsor.
        //    Address::zero(),
        //    // TODO(webbhorn): Pass the actual outbox chain ID.
        //    Chain::Mainnet,
        //),
        ///////////////////////////////////////////////
        ///////////////////////////////////////////////
        ///////////////////////////////////////////////

        let _fee_token = gelato::fwd_req_call::NATIVE_FEE_TOKEN_ADDRESS;

        // TODO(webbhorn): It might be better to get the chain_id (via abacus domain) from Abacus
        // code and keep our Gelato crate abacus-agnostic. I think there is a macro somewhere in
        // abacus-base or abacus-core that does this or tracks the relation...
        let _target_chain_id: Chain =
            Chain::from_abacus_domain(self.inbox_contracts.inbox.local_domain());
        let _sponsor_chain_id = Chain::from_abacus_domain(self.outbox_domain);

        todo!()
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
