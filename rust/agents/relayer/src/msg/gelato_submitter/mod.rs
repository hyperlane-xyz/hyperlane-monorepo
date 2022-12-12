use std::sync::Arc;

use eyre::{bail, Result};
use gelato::types::Chain;
use hyperlane_base::chains::GelatoConf;
use hyperlane_base::{CachingMailbox, CoreMetrics};
use hyperlane_core::db::HyperlaneDB;
use hyperlane_core::{HyperlaneChain, HyperlaneDomain, MultisigIsm};
use prometheus::{IntCounter, IntGauge};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::time::{sleep, Duration};
use tokio::{sync::mpsc::error::TryRecvError, task::JoinHandle};
use tracing::{info_span, instrument::Instrumented, Instrument};

use crate::msg::gelato_submitter::sponsored_call_op::{
    SponsoredCallOp, SponsoredCallOpArgs, SponsoredCallOptions,
};

use super::gas_payment::GasPaymentEnforcer;
use super::SubmitMessageArgs;

mod sponsored_call_op;

const HTTP_CLIENT_REQUEST_SECONDS: u64 = 30;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// The Gelato config.
    gelato_config: GelatoConf,
    /// Source of messages to submit.
    message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// Mailbox on the destination chain.
    mailbox: CachingMailbox,
    /// Multisig ISM on the destination chain.
    multisig_ism: Arc<dyn MultisigIsm>,
    /// The destination chain in the format expected by the Gelato crate.
    destination_gelato_chain: Chain,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: HyperlaneDB,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    http_client: reqwest::Client,
    /// Prometheus metrics.
    metrics: GelatoSubmitterMetrics,
    /// Channel used by SponsoredCallOps to send that their message has been successfully processed.
    message_processed_sender: UnboundedSender<SubmitMessageArgs>,
    /// Channel to receive from SponsoredCallOps that a message has been successfully processed.
    message_processed_receiver: UnboundedReceiver<SubmitMessageArgs>,
    /// Used to determine if messages have made sufficient gas payments.
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
}

impl GelatoSubmitter {
    pub fn new(
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        mailbox: CachingMailbox,
        multisig_ism: Arc<dyn MultisigIsm>,
        hyperlane_db: HyperlaneDB,
        gelato_config: GelatoConf,
        metrics: GelatoSubmitterMetrics,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> Self {
        let (message_processed_sender, message_processed_receiver) =
            mpsc::unbounded_channel::<SubmitMessageArgs>();
        let http_client = reqwest::ClientBuilder::new()
            .timeout(Duration::from_secs(HTTP_CLIENT_REQUEST_SECONDS))
            .build()
            .unwrap();
        Self {
            message_receiver,
            destination_gelato_chain: hyperlane_domain_id_to_gelato_chain(mailbox.domain())
                .unwrap(),
            mailbox,
            multisig_ism,
            db: hyperlane_db,
            gelato_config,
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
        // them into the `received_messages` in asc order by message nonce.
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

        // Spawn a SponsoredCallOp for each received message.
        for msg in received_messages.into_iter() {
            tracing::info!(msg=?msg, "Spawning sponsored call op for message");
            let mut op = SponsoredCallOp::new(SponsoredCallOpArgs {
                opts: SponsoredCallOptions::default(),
                http: self.http_client.clone(),
                message: msg,
                mailbox: self.mailbox.clone(),
                multisig_ism: self.multisig_ism.clone(),
                sponsor_api_key: self.gelato_config.sponsorapikey.clone(),
                destination_chain: self.destination_gelato_chain,
                message_processed_sender: self.message_processed_sender.clone(),
                gas_payment_enforcer: self.gas_payment_enforcer.clone(),
            });
            self.metrics.active_sponsored_call_ops_gauge.add(1);

            tokio::spawn(async move { op.run().await });
        }

        // Pull any messages that have been successfully processed by SponsoredCallOps
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

    /// Record in HyperlaneDB and various metrics that this process has observed the successful
    /// processing of a message. An Ok(()) value returned by this function is the 'commit' point
    /// in a message's lifetime for final processing -- after this function has been seen to
    /// return 'Ok(())', then without a wiped HyperlaneDB, we will never re-attempt processing for
    /// this message again, even after the relayer restarts.
    fn record_message_process_success(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        tracing::info!(msg=?msg, "Recording message as successfully processed");
        self.db.mark_nonce_as_processed(msg.message.nonce)?;

        self.metrics.active_sponsored_call_ops_gauge.sub(1);
        self.metrics.highest_submitted_nonce =
            std::cmp::max(self.metrics.highest_submitted_nonce, msg.message.nonce);
        self.metrics
            .processed_gauge
            .set(self.metrics.highest_submitted_nonce as i64);
        self.metrics.messages_processed_count.inc();
        Ok(())
    }
}

#[derive(Debug)]
pub(crate) struct GelatoSubmitterMetrics {
    processed_gauge: IntGauge,
    messages_processed_count: IntCounter,
    active_sponsored_call_ops_gauge: IntGauge,
    /// Private state used to update actual metrics each tick.
    highest_submitted_nonce: u32,
}

impl GelatoSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, origin_chain: &str, destination_chain: &str) -> Self {
        Self {
            messages_processed_count: metrics
                .messages_processed_count()
                .with_label_values(&[origin_chain, destination_chain]),
            processed_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin_chain,
                destination_chain,
            ]),
            active_sponsored_call_ops_gauge: metrics.submitter_queue_length().with_label_values(&[
                origin_chain,
                destination_chain,
                "active_sponsored_call_ops",
            ]),
            highest_submitted_nonce: 0,
        }
    }
}

// While this may be more ergonomic as an Into / From impl,
// it feels a bit awkward to have hyperlane-base (where HyperlaneDomain)
// is implemented to be aware of the gelato crate or vice versa.
pub fn hyperlane_domain_id_to_gelato_chain(domain: u32) -> Result<Chain> {
    let hyperlane_domain = HyperlaneDomain::try_from(domain)?;

    Ok(match hyperlane_domain {
        HyperlaneDomain::Ethereum => Chain::Ethereum,
        HyperlaneDomain::Goerli => Chain::Goerli,

        HyperlaneDomain::Polygon => Chain::Polygon,
        HyperlaneDomain::Mumbai => Chain::Mumbai,

        HyperlaneDomain::Avalanche => Chain::Avalanche,
        HyperlaneDomain::Fuji => Chain::Fuji,

        HyperlaneDomain::Arbitrum => Chain::Arbitrum,
        HyperlaneDomain::ArbitrumGoerli => Chain::ArbitrumGoerli,

        HyperlaneDomain::Optimism => Chain::Optimism,
        HyperlaneDomain::OptimismGoerli => Chain::OptimismGoerli,

        HyperlaneDomain::BinanceSmartChain => Chain::BinanceSmartChain,
        HyperlaneDomain::BinanceSmartChainTestnet => Chain::BinanceSmartChainTestnet,

        HyperlaneDomain::Celo => Chain::Celo,
        HyperlaneDomain::Alfajores => Chain::Alfajores,

        HyperlaneDomain::Moonbeam => Chain::Moonbeam,
        HyperlaneDomain::MoonbaseAlpha => Chain::MoonbaseAlpha,

        HyperlaneDomain::Zksync2Testnet => Chain::Zksync2Testnet,

        _ => bail!("No Gelato Chain for domain {hyperlane_domain}"),
    })
}

#[test]
fn test_hyperlane_domain_id_to_gelato_chain() {
    use hyperlane_core::HyperlaneDomainType;
    use strum::IntoEnumIterator;

    // Iterate through all HyperlaneDomains, ensuring all mainnet and testnet domains
    // are included in hyperlane_domain_id_to_gelato_chain.
    for hyperlane_domain in HyperlaneDomain::iter() {
        if let HyperlaneDomainType::Mainnet | HyperlaneDomainType::Testnet =
            hyperlane_domain.domain_type()
        {
            assert!(hyperlane_domain_id_to_gelato_chain(u32::from(hyperlane_domain)).is_ok());
        }
    }
}
