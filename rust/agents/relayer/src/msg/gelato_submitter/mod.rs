use std::sync::Arc;

use abacus_base::{CoreMetrics, InboxContracts};
use abacus_core::AbacusCommon;
use abacus_core::{db::AbacusDB, Signers};
use ethers::signers::Signer;
use ethers::types::Address;
use eyre::{bail, Result};
use gelato::chains::Chain;
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::time::{sleep, Duration, Instant};
use tokio::{sync::mpsc::error::TryRecvError, task::JoinHandle};
use tracing::{info_span, instrument::Instrumented, Instrument};

use crate::msg::gelato_submitter::fwd_req_op::{
    ForwardRequestOp, ForwardRequestOpArgs, ForwardRequestOptions,
};

use super::SubmitMessageArgs;
use super::gas_payment_enforcer::GasPaymentEnforcer;

mod fwd_req_op;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// Inbox / InboxValidatorManager on the destination chain.
    inbox_contracts: InboxContracts,
    /// The outbox chain in the format expected by the Gelato crate.
    outbox_gelato_chain: Chain,
    /// The inbox chain in the format expected by the Gelato crate.
    inbox_gelato_chain: Chain,
    /// The signer of the Gelato sponsor, used for EIP-712 meta-transaction signatures.
    gelato_sponsor_signer: Signers,
    /// The address of the Gelato sponsor.
    gelato_sponsor_address: Address,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    http_client: reqwest::Client,
    /// Prometheus metrics.
    metrics: GelatoSubmitterMetrics,
    /// Channel used by ForwardRequestOps to send that their message has been successfully processed.
    message_processed_sender: UnboundedSender<SubmitMessageArgs>,
    /// Channel to receive from ForwardRequestOps that a message has been successfully processed.
    message_processed_receiver: UnboundedReceiver<SubmitMessageArgs>,
    /// Used to determine if messages have made sufficient gas payments.
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
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
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> Self {
        let (message_processed_sender, message_processed_receiver) =
            mpsc::unbounded_channel::<SubmitMessageArgs>();
        Self {
            message_receiver,
            outbox_gelato_chain: abacus_domain_to_gelato_chain(outbox_domain).unwrap(),
            inbox_gelato_chain: abacus_domain_to_gelato_chain(inbox_contracts.inbox.local_domain())
                .unwrap(),
            inbox_contracts,
            db: abacus_db,
            gelato_sponsor_address: gelato_sponsor_signer.address(),
            gelato_sponsor_signer,
            http_client,
            metrics,
            message_processed_sender,
            message_processed_receiver,
            gas_payment_enforcer,
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

        // Spawn a ForwardRequestOp for each received message.
        for msg in received_messages.into_iter() {
            tracing::info!(msg=?msg, "Spawning forward request op for message");
            let mut op = ForwardRequestOp::new(ForwardRequestOpArgs {
                opts: ForwardRequestOptions::default(),
                http: self.http_client.clone(),
                message: msg,
                inbox_contracts: self.inbox_contracts.clone(),
                sponsor_signer: self.gelato_sponsor_signer.clone(),
                sponsor_address: self.gelato_sponsor_address,
                sponsor_chain: self.outbox_gelato_chain,
                destination_chain: self.inbox_gelato_chain,
                message_processed_sender: self.message_processed_sender.clone(),
                gas_payment_enforcer: self.gas_payment_enforcer.clone(),
            });
            self.metrics.active_forward_request_ops_gauge.add(1);

            tokio::spawn(async move { op.run().await });
        }

        // Pull any messages that have been successfully processed by ForwardRequestOps
        loop {
            match self.message_processed_receiver.try_recv() {
                Ok(msg) => {
                    self.record_message_process_success(&msg)?;
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

    /// Record in AbacusDB and various metrics that this process has observed the successful
    /// processing of a message. An Ok(()) value returned by this function is the 'commit' point
    /// in a message's lifetime for final processing -- after this function has been seen to
    /// return 'Ok(())', then without a wiped AbacusDB, we will never re-attempt processing for
    /// this message again, even after the relayer restarts.
    fn record_message_process_success(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        tracing::info!(msg=?msg, "Recording message as successfully processed");
        self.db.mark_leaf_as_processed(msg.leaf_index)?;

        self.metrics.active_forward_request_ops_gauge.sub(1);
        self.metrics
            .queue_duration_hist
            .observe((Instant::now() - msg.enqueue_time).as_secs_f64());
        self.metrics.highest_submitted_leaf_index =
            std::cmp::max(self.metrics.highest_submitted_leaf_index, msg.leaf_index);
        self.metrics
            .processed_gauge
            .set(self.metrics.highest_submitted_leaf_index as i64);
        self.metrics.messages_processed_count.inc();
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct GelatoSubmitterMetrics {
    queue_duration_hist: Histogram,
    processed_gauge: IntGauge,
    messages_processed_count: IntCounter,
    active_forward_request_ops_gauge: IntGauge,
    /// Private state used to update actual metrics each tick.
    highest_submitted_leaf_index: u32,
}

impl GelatoSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
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
            active_forward_request_ops_gauge: metrics
                .submitter_queue_length()
                .with_label_values(&[outbox_chain, inbox_chain, "active_forward_request_ops"]),
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
