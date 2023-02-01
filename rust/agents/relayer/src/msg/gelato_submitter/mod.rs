use std::sync::Arc;
use std::time::Duration;

use eyre::{bail, Result};
use prometheus::{IntCounter, IntGauge};
use tokio::sync::mpsc::{self, error::TryRecvError, UnboundedReceiver, UnboundedSender};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info_span, instrument::Instrumented, Instrument};

use gelato::types::Chain;
use hyperlane_base::{chains::GelatoConf, CachingMailbox, CoreMetrics};
use hyperlane_core::{db::HyperlaneDB, HyperlaneChain, HyperlaneDomain, KnownHyperlaneDomain};

use super::gas_payment::GasPaymentEnforcer;
use super::metadata_builder::MetadataBuilder;
use super::SubmitMessageArgs;
use crate::msg::gelato_submitter::sponsored_call_op::{
    SponsoredCallOp, SponsoredCallOpArgs, SponsoredCallOptions,
};

mod sponsored_call_op;

const HTTP_CLIENT_REQUEST_SECONDS: u64 = 30;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// The Gelato config.
    gelato_config: GelatoConf,
    /// Source of messages to submit.
    message_receiver: UnboundedReceiver<SubmitMessageArgs>,
    /// Mailbox on the destination chain.
    mailbox: CachingMailbox,
    /// Metadata builder for the destination chain.
    metadata_builder: MetadataBuilder,
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
        message_receiver: UnboundedReceiver<SubmitMessageArgs>,
        mailbox: CachingMailbox,
        metadata_builder: MetadataBuilder,
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
            metadata_builder,
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
                metadata_builder: self.metadata_builder.clone(),
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
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        let origin_name = origin.name();
        let destination_name = destination.name();
        Self {
            messages_processed_count: metrics
                .messages_processed_count()
                .with_label_values(&[origin_name, destination_name]),
            processed_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin_name,
                destination_name,
            ]),
            active_sponsored_call_ops_gauge: metrics.submitter_queue_length().with_label_values(&[
                origin_name,
                destination_name,
                "active_sponsored_call_ops",
            ]),
            highest_submitted_nonce: 0,
        }
    }
}

// While this may be more ergonomic as an Into / From impl,
// it feels a bit awkward to have hyperlane-base (where HyperlaneDomain)
// is implemented to be aware of the gelato crate or vice versa.
pub fn hyperlane_domain_id_to_gelato_chain(domain: &HyperlaneDomain) -> Result<Chain> {
    Ok(match domain {
        HyperlaneDomain::Known(d) => match d {
            KnownHyperlaneDomain::Ethereum => Chain::Ethereum,
            KnownHyperlaneDomain::Goerli => Chain::Goerli,

            KnownHyperlaneDomain::Polygon => Chain::Polygon,
            KnownHyperlaneDomain::Mumbai => Chain::Mumbai,

            KnownHyperlaneDomain::Avalanche => Chain::Avalanche,
            KnownHyperlaneDomain::Fuji => Chain::Fuji,

            KnownHyperlaneDomain::Arbitrum => Chain::Arbitrum,
            KnownHyperlaneDomain::ArbitrumGoerli => Chain::ArbitrumGoerli,

            KnownHyperlaneDomain::Optimism => Chain::Optimism,
            KnownHyperlaneDomain::OptimismGoerli => Chain::OptimismGoerli,

            KnownHyperlaneDomain::BinanceSmartChain => Chain::BinanceSmartChain,
            KnownHyperlaneDomain::BinanceSmartChainTestnet => Chain::BinanceSmartChainTestnet,

            KnownHyperlaneDomain::Celo => Chain::Celo,
            KnownHyperlaneDomain::Alfajores => Chain::Alfajores,

            KnownHyperlaneDomain::Moonbeam => Chain::Moonbeam,
            KnownHyperlaneDomain::MoonbaseAlpha => Chain::MoonbaseAlpha,

            KnownHyperlaneDomain::Gnosis => Chain::Gnosis,

            KnownHyperlaneDomain::Zksync2Testnet => Chain::Zksync2Testnet,

            _ => bail!("No Gelato Chain for domain {domain}"),
        },

        _ => bail!("No Gelato Chain for domain {domain}"),
    })
}

#[test]
fn test_hyperlane_domain_id_to_gelato_chain() {
    use hyperlane_core::{HyperlaneDomainType, KnownHyperlaneDomain};
    use strum::IntoEnumIterator;

    // Iterate through all HyperlaneDomains, ensuring all mainnet and testnet domains
    // are included in hyperlane_domain_id_to_gelato_chain.
    for domain in KnownHyperlaneDomain::iter() {
        if let HyperlaneDomainType::Mainnet | HyperlaneDomainType::Testnet = domain.domain_type() {
            assert!(hyperlane_domain_id_to_gelato_chain(&HyperlaneDomain::Known(domain)).is_ok());
        }
    }
}
