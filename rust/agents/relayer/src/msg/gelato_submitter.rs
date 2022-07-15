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

const DEFAULT_MAX_FEE: u32 = 1_000_000_000;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    messages: mpsc::UnboundedReceiver<SubmitMessageArgs>,

    /// The Abacus domain of the source chain for messages to be submitted via this GelatoSubmitter.
    outbox_domain: u32,

    /// The Abacus domain of the destination chain for messages submitted with this GelatoSubmitter.
    inbox_domain: u32,
    /// The on-chain address of the inbox contract on the destination chain.
    inbox_address: Address,

    /// The ethers BaseContract representing the
    /// InboxValidatorManager ABI, used to encode process() calldata
    /// into Gelato ForwardRequest arg.
    ivm_base_contract: BaseContract,
    /// Address of the inbox validator manager contract that will be specified
    /// to Gelato in ForwardRequest submissions to process new messages.
    ivm_address: Address,

    /// The address of the 'sponsor' contract providing payment to Gelato.
    sponsor_address: Address,

    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    /// TODO(webbhorn): Promote to non-_-prefixed name once we're checking gas payments.
    _db: AbacusDB,

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
        messages: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        outbox_domain: u32,
        inbox_domain: u32,
        inbox_address: abacus_core::Address,
        ivm_base_contract: BaseContract,
        ivm_address: abacus_core::Address,
        sponsor_address: Address,
        db: AbacusDB,
        signer: Signers,
        metrics: GelatoSubmitterMetrics,
    ) -> Self {
        Self {
            messages,
            outbox_domain,
            inbox_domain,
            inbox_address: inbox_address.into(),
            ivm_base_contract,
            ivm_address: ivm_address.into(),
            sponsor_address,
            _db: db,
            signer,
            http: reqwest::Client::new(),
            _metrics: metrics,
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
            match self.messages.try_recv() {
                Ok(msg) => {
                    let op = ForwardRequestOp {
                        args: self.make_forward_request_args(msg)?,
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

    fn make_forward_request_args(&self, msg: SubmitMessageArgs) -> Result<ForwardRequestArgs> {
        let mut proof: [[u8; 32]; 32] = Default::default();
        proof
            .iter_mut()
            .enumerate()
            .for_each(|(i, elem)| *elem = msg.proof.path[i].to_fixed_bytes());
        let call_data = self.ivm_base_contract.encode(
            "process",
            [
                Token::Address(self.inbox_address),
                Token::FixedBytes(msg.checkpoint.checkpoint.root.to_fixed_bytes().into()),
                Token::Uint(msg.checkpoint.checkpoint.index.into()),
                Token::Array(
                    msg.checkpoint
                        .signatures
                        .iter()
                        .map(|s| Token::Bytes(s.to_vec()))
                        .collect(),
                ),
                Token::Bytes(msg.committed_message.message.to_vec()),
                Token::FixedArray(
                    proof
                        .iter()
                        .map(|s| Token::FixedBytes(s.to_vec()))
                        .collect(),
                ),
                Token::Uint(msg.leaf_index.into()),
            ],
        )?;
        Ok(ForwardRequestArgs {
            chain_id: abacus_domain_to_gelato_chain(self.inbox_domain)?,
            target: self.ivm_address,
            data: call_data,
            fee_token: NATIVE_FEE_TOKEN_ADDRESS,
            payment_type: PaymentType::AsyncGasTank,
            max_fee: DEFAULT_MAX_FEE.into(), // Maximum fee that sponsor is willing to pay.
            gas: DEFAULT_MAX_FEE.into(),     // Gas limit.
            sponsor_chain_id: abacus_domain_to_gelato_chain(self.outbox_domain)?,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            sponsor: self.sponsor_address,
        })
    }
}

// TODO(webbhorn): Is there already somewhere actually canonical/authoritative to use instead
// of duplicating this here?  Perhaps we can expand `macro_rules! domain_and_chain`?
// Otherwise, try to keep this translation logic out of the gelato crate at least so that we
// don't start introducing any Abacus concepts (like domain) into it.
fn abacus_domain_to_gelato_chain(domain: u32) -> Result<Chain> {
    Ok(match domain {
        6648936 => Chain::Mainnet,
        1634872690 => Chain::Rinkeby,
        3000 => Chain::Kovan,
        1886350457 => Chain::Polygon,
        80001 => Chain::PolygonMumbai,
        1635148152 => Chain::Avalanche,
        43113 => Chain::AvalancheFuji,
        6386274 => Chain::Arbitrum,
        28528 => Chain::Optimism,
        1869622635 => Chain::OptimismKovan,
        6452067 => Chain::BinanceSmartChain,
        1651715444 => Chain::BinanceSmartChainTestnet,
        // TODO(webbhorn): Uncomment once Gelato supports Celo.
        // 1667591279 => Chain::Celo,
        // TODO(webbhorn): Need Alfajores support too.
        // TODO(webbhorn): What is the difference between ArbitrumRinkeby and ArbitrumTestnet?
        // 421611 => Chain::ArbitrumTestnet,
        // TODO(webbhorn): Abacus hasn't assigned a domain id for Alfajores yet.
        // 5 => Chain::Goerli,
        _ => bail!("Unknown domain {}", domain),
    })
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
