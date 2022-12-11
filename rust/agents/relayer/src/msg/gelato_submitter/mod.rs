use std::sync::Arc;
use std::time::{Duration, Instant};

use eyre::{bail, Result};
use prometheus::{Histogram, IntCounter, IntGauge};
use tokio::sync::mpsc::{self, error::TryRecvError, UnboundedReceiver, UnboundedSender};
use tokio::{task::JoinHandle, time::sleep};
use tracing::{info_span, instrument::Instrumented, Instrument};

use abacus_base::{chains::GelatoConf, CoreMetrics, InboxContracts};
use abacus_core::{db::AbacusDB, AbacusChain, AbacusDomain};
use gelato::types::Chain;

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
    message_receiver: UnboundedReceiver<SubmitMessageArgs>,
    /// Inbox / InboxValidatorManager on the destination chain.
    inbox_contracts: InboxContracts,
    /// The inbox chain in the format expected by the Gelato crate.
    inbox_gelato_chain: Chain,
    /// Interface to agent rocks DB for e.g. writing delivery status upon completion.
    db: AbacusDB,
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
        inbox_contracts: InboxContracts,
        abacus_db: AbacusDB,
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
            inbox_gelato_chain: abacus_domain_id_to_gelato_chain(
                inbox_contracts.inbox.local_domain(),
            )
            .unwrap(),
            inbox_contracts,
            db: abacus_db,
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

        // Spawn a SponsoredCallOp for each received message.
        for msg in received_messages.into_iter() {
            tracing::info!(msg=?msg, "Spawning sponsored call op for message");
            let mut op = SponsoredCallOp::new(SponsoredCallOpArgs {
                opts: SponsoredCallOptions::default(),
                http: self.http_client.clone(),
                message: msg,
                inbox_contracts: self.inbox_contracts.clone(),
                sponsor_api_key: self.gelato_config.sponsorapikey.clone(),
                destination_chain: self.inbox_gelato_chain,
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

    /// Record in AbacusDB and various metrics that this process has observed the successful
    /// processing of a message. An Ok(()) value returned by this function is the 'commit' point
    /// in a message's lifetime for final processing -- after this function has been seen to
    /// return 'Ok(())', then without a wiped AbacusDB, we will never re-attempt processing for
    /// this message again, even after the relayer restarts.
    fn record_message_process_success(&mut self, msg: &SubmitMessageArgs) -> Result<()> {
        tracing::info!(msg=?msg, "Recording message as successfully processed");
        self.db.mark_leaf_as_processed(msg.leaf_index)?;

        self.metrics.active_sponsored_call_ops_gauge.sub(1);
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
    active_sponsored_call_ops_gauge: IntGauge,
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
            active_sponsored_call_ops_gauge: metrics.submitter_queue_length().with_label_values(&[
                outbox_chain,
                inbox_chain,
                "active_sponsored_call_ops",
            ]),
            highest_submitted_leaf_index: 0,
        }
    }
}

// While this may be more ergonomic as an Into / From impl,
// it feels a bit awkward to have abacus-base (where AbacusDomain)
// is implemented to be aware of the gelato crate or vice versa.
pub fn abacus_domain_id_to_gelato_chain(domain: u32) -> Result<Chain> {
    let abacus_domain = AbacusDomain::try_from(domain)?;

    Ok(match abacus_domain {
        AbacusDomain::Ethereum => Chain::Ethereum,
        AbacusDomain::Kovan => Chain::Kovan,
        AbacusDomain::Goerli => Chain::Goerli,

        AbacusDomain::Polygon => Chain::Polygon,
        AbacusDomain::Mumbai => Chain::Mumbai,

        AbacusDomain::Avalanche => Chain::Avalanche,
        AbacusDomain::Fuji => Chain::Fuji,

        AbacusDomain::Arbitrum => Chain::Arbitrum,
        AbacusDomain::ArbitrumRinkeby => Chain::ArbitrumRinkeby,
        AbacusDomain::ArbitrumGoerli => Chain::ArbitrumGoerli,

        AbacusDomain::Optimism => Chain::Optimism,
        AbacusDomain::OptimismKovan => Chain::OptimismKovan,
        AbacusDomain::OptimismGoerli => Chain::OptimismGoerli,

        AbacusDomain::BinanceSmartChain => Chain::BinanceSmartChain,
        AbacusDomain::BinanceSmartChainTestnet => Chain::BinanceSmartChainTestnet,

        AbacusDomain::Celo => Chain::Celo,
        AbacusDomain::Alfajores => Chain::Alfajores,

        AbacusDomain::MoonbaseAlpha => Chain::MoonbaseAlpha,
        AbacusDomain::Moonbeam => Chain::Moonbeam,

        AbacusDomain::Zksync2Testnet => Chain::Zksync2Testnet,

        _ => bail!("No Gelato Chain for domain {abacus_domain}"),
    })
}

#[test]
fn test_abacus_domain_id_to_gelato_chain() {
    use abacus_core::AbacusDomainType;
    use strum::IntoEnumIterator;

    // Iterate through all AbacusDomains, ensuring all mainnet and testnet domains
    // are included in abacus_domain_id_to_gelato_chain.
    for abacus_domain in AbacusDomain::iter() {
        if let AbacusDomainType::Mainnet | AbacusDomainType::Testnet = abacus_domain.domain_type() {
            assert!(abacus_domain_id_to_gelato_chain(u32::from(abacus_domain)).is_ok());
        }
    }
}
