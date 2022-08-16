use std::collections::VecDeque;

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

use self::fwd_req_op::{ForwardRequestOp, ForwardRequestOptions};

use super::SubmitMessageArgs;

mod fwd_req_op;

/// The max fee to use for Gelato ForwardRequests.
/// Gelato isn't charging fees on testnet. For now, use this hardcoded value
/// of 1e18, or 1.0 ether.
/// TODO: revisit when testing on mainnet and actually considering interchain
/// gas payments.
const DEFAULT_MAX_FEE: u64 = 1000000000000000000;

/// The default gas limit to use for Gelato ForwardRequests.
/// TODO: instead estimate gas for messages.
const DEFAULT_GAS_LIMIT: u64 = 3000000;

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
    pub wait_queue: VecDeque<SubmitMessageArgs>,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    pub _abacus_db: AbacusDB,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
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
            wait_queue: VecDeque::new(),
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
        // Pull any messages sent by processor over channel and push
        // them into the `received_messages` in asc order by message leaf index.
        let mut received_messages = Vec::new();
        loop {
            match self.message_receiver.try_recv() {
                Ok(msg) => {
                    received_messages.push(msg);
                }
                Err(TryRecvError::Empty) => {
                    break;
                }
                Err(_) => {
                    bail!("Disconnected receive channel or fatal err");
                }
            }
        }

        // Insert received messages into the front of the wait queue, ensuring
        // the asc ordering by message leaf index is preserved.
        for msg in received_messages.into_iter().rev() {
            self.wait_queue.push_front(msg);
        }

        // TODO: correctly process the wait queue.
        // Messages should be popped from the wait queue. For messages
        // with successful gas estimation, a ForwardRequestOp should
        // be created. Messages whose gas estimation reverts should be
        // pushed to the back of the queue.

        // Pick the next message to try processing.
        let msg = match self.wait_queue.pop_front() {
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
            max_fee: DEFAULT_MAX_FEE.into(),
            gas: DEFAULT_GAS_LIMIT.into(),
            sponsor_chain_id: self.outbox_gelato_chain,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            sponsor: self.gelato_sponsor_address,
        })
    }
}

// TODO(tkporter): Drop allow dead code directive once we handle
// updating each of these metrics.
#[allow(dead_code)]
#[derive(Debug)]
pub(crate) struct GelatoSubmitterMetrics {
    wait_queue_length_gauge: IntGauge,
    queue_duration_hist: Histogram,
    processed_gauge: IntGauge,
    messages_processed_count: IntCounter,

    /// Private state used to update actual metrics each tick.
    highest_submitted_leaf_index: u32,
}

impl GelatoSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
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
            highest_submitted_leaf_index: 0,
        }
    }
}

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
