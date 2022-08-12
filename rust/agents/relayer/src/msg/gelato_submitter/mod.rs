use abacus_base::{CoreMetrics, InboxContracts};
use abacus_core::{db::AbacusDB, Signers};
use abacus_core::{AbacusCommon, InboxValidatorManager};
use ethers::signers::Signer;
use ethers::types::{Address, U256};
use eyre::{bail, Result};
use gelato::chains::Chain;
use gelato::fwd_req_call::{ForwardRequestArgs, PaymentType, NATIVE_FEE_TOKEN_ADDRESS};
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use tokio::{sync::mpsc::error::TryRecvError, task::JoinHandle};
use tracing::{info_span, instrument::Instrumented, Instrument};

use gelato::fwd_req_call::{ForwardRequestArgs, PaymentType};
use gelato::fwd_req_op::{ForwardRequestOp, ForwardRequestOptions};

mod fwd_req_op;

/// The max fee to use for Gelato ForwardRequests.
/// Gelato isn't charging fees on testnet. For now, use this hardcoded value
/// of 1e18, or 1.0 ether.
/// TODO: revisit when testing on mainnet and actually considering interchain
/// gas payments.
const DEFAULT_MAX_FEE: u64 = 1000000000000000000;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    pub message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// Inbox / InboxValidatorManager on the destination chain.
    pub inbox_contracts: InboxContracts,
    /// The outbox chain in the format expected by the Gelato crate.
    pub outbox_gelato_chain: Chain,
    /// The inbox chain in the format expected by the Gelato crate.
    pub inbox_gelato_chain: Chain,
    /// The signer of the Gelato sponsor, used for EIP-712 meta-transaction signatures.
    pub gelato_sponsor_signer: Signers,
    /// The address of the Gelato sponsor.
    pub gelato_sponsor_address: Address,
    /// Messages we are aware of that we want to eventually submit, but haven't yet, for
    /// whatever reason.
    pub wait_queue: Vec<SubmitMessageArgs>,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    pub _abacus_db: AbacusDB,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    /// Intended to be shared by reqwest library.
    pub http_client: reqwest::Client,
    /// Prometheus metrics.
    pub _metrics: GelatoSubmitterMetrics,
}

impl GelatoSubmitter {
    pub fn new(
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        outbox_domain: u32,
        inbox_contracts: InboxContracts,
        abacus_db: AbacusDB,
        gelato_sponsor_signer: Signers,
        http_client: reqwest::Client,
        metrics: GelatoSubmitterMetrics,
    ) -> Self {
        Self {
            message_receiver,
            outbox_gelato_chain: abacus_domain_to_gelato_chain(outbox_domain).unwrap(),
            inbox_gelato_chain: abacus_domain_to_gelato_chain(inbox_contracts.inbox.local_domain())
                .unwrap(),
            inbox_contracts,
            _abacus_db: abacus_db,
            gelato_sponsor_address: gelato_sponsor_signer.address(),
            gelato_sponsor_signer,
            http_client,
            _metrics: metrics,
            wait_queue: Vec::new(),
        }
    }

    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("gelato submitter work loop"))
    }

    async fn work_loop(&mut self) -> Result<()> {
        loop {
            self.tick().await?;
            sleep(Duration::from_millis(1000)).await;
        }
    }

    async fn tick(&mut self) -> Result<()> {
        // Pull any messages sent by processor over channel.
        loop {
            match self.message_receiver.try_recv() {
                Ok(msg) => {
                    self.wait_queue.push(msg);
                }
                Err(TryRecvError::Empty) => {
                    break;
                }
                Err(_) => {
                    bail!("Disconnected receive channel or fatal err");
                }
            }
        }

        // TODO: process the wait queue, creating a ForwardRequestOp for each
        // message that we successfully estimate gas for.

        // Pick the next message to try processing.
        let msg = match self.wait_queue.pop() {
            Some(m) => m,
            None => return Ok(()),
        };

        let op = ForwardRequestOp {
            args: self.create_forward_request_args(msg)?,
            opts: ForwardRequestOptions::default(),
            signer: self.gelato_sponsor_signer.clone(),
            http: self.http_client.clone(),
        };

        tokio::spawn(async move {
            op.run()
                .await
                .expect("failed unimplemented forward request submit op");
        });

        Ok(())
    }

    fn create_forward_request_args(&self, msg: SubmitMessageArgs) -> Result<ForwardRequestArgs> {
        let calldata = self.inbox_contracts.validator_manager.process_calldata(
            &msg.checkpoint,
            &msg.committed_message.message,
            &msg.proof,
        )?;
        Ok(ForwardRequestArgs {
            chain_id: self.inbox_gelato_chain,
            target: self
                .inbox_contracts
                .validator_manager
                .contract_address()
                .into(),
            data: calldata,
            fee_token: NATIVE_FEE_TOKEN_ADDRESS,
            payment_type: PaymentType::AsyncGasTank,
            max_fee: DEFAULT_MAX_FEE.into(), // Maximum fee that sponsor is willing to pay.
            gas: DEFAULT_MAX_FEE.into(),     // Gas limit.
            sponsor_chain_id: self.outbox_gelato_chain,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            sponsor: self.gelato_sponsor_address,
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

// TODO(webbhorn): Is there already somewhere actually canonical/authoritative to use instead
// of duplicating this here?  Perhaps we can expand `macro_rules! domain_and_chain`?
// Otherwise, try to keep this translation logic out of the gelato crate at least so that we
// don't start introducing any Abacus concepts (like domain) into it.
fn abacus_domain_to_gelato_chain(domain: u32) -> Result<Chain> {
    Ok(match domain {
        6648936 => Chain::Ethereum,
        1634872690 => Chain::Rinkeby,
        3000 => Chain::Kovan,

        1886350457 => Chain::Polygon,
        80001 => Chain::PolygonMumbai,

        1635148152 => Chain::Avalanche,
        43113 => Chain::AvalancheFuji,

        6386274 => Chain::Arbitrum,
        421611 => Chain::ArbitrumRinkeby,

        28528 => Chain::Optimism,
        1869622635 => Chain::OptimismKovan,

        6452067 => Chain::BinanceSmartChain,
        1651715444 => Chain::BinanceSmartChainTestnet,

        1667591279 => Chain::Celo,
        1000 => Chain::Alfajores,

        _ => bail!("Unknown domain {}", domain),
    })
}
