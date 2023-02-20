use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{Context, Result};
use hyperlane_core::U256;
use tokio::sync::{
    mpsc::{self, UnboundedReceiver, UnboundedSender},
    RwLock,
};
use tokio::task::JoinHandle;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::{
    chains::{GelatoConf, TransactionSubmissionType},
    run_all, BaseAgent, CachingInterchainGasPaymaster, CachingMailbox, ContractSyncMetrics,
    CoreMetrics, HyperlaneAgentCore,
};
use hyperlane_core::{db::DB, HyperlaneChain, HyperlaneDomain, ValidatorAnnounce};

use crate::{
    merkle_tree_builder::MerkleTreeBuilder,
    msg::{
        gas_payment::GasPaymentEnforcer,
        gelato_submitter::{GelatoSubmitter, GelatoSubmitterMetrics},
        metadata_builder::MetadataBuilder,
        processor::{MessageProcessor, MessageProcessorMetrics},
        serial_submitter::{SerialSubmitter, SerialSubmitterMetrics},
        SubmitMessageArgs,
    },
    settings::{matching_list::MatchingList, GasPaymentEnforcementConfig, RelayerSettings},
};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    origin_chain: HyperlaneDomain,
    core: HyperlaneAgentCore,
    mailboxes: HashMap<HyperlaneDomain, CachingMailbox>,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    interchain_gas_paymasters: HashMap<HyperlaneDomain, CachingInterchainGasPaymaster>,
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
    transaction_gas_limit: Option<U256>,
    skip_transaction_gas_limit_for: HashSet<u32>,
}

impl AsRef<HyperlaneAgentCore> for Relayer {
    fn as_ref(&self) -> &HyperlaneAgentCore {
        &self.core
    }
}

#[async_trait]
#[allow(clippy::unit_arg)]
impl BaseAgent for Relayer {
    const AGENT_NAME: &'static str = "relayer";

    type Settings = RelayerSettings;

    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized,
    {
        let core = settings.build_hyperlane_core(metrics.clone());
        let db = DB::from_path(&settings.db)?;

        let chain_names: Vec<_> = if let Some(ref remotes) = settings.destinationchainnames {
            // Use defined remote chains + the origin chain
            remotes
                .split(',')
                .chain([settings.originchainname.as_str()])
                .collect()
        } else {
            // If not provided, default to using every chain listed in self.chains.
            settings.chains.keys().map(String::as_str).collect()
        };

        let mailboxes = settings
            .build_all_mailboxes(chain_names.as_slice(), &metrics, db.clone())
            .await?;
        let interchain_gas_paymasters = settings
            .build_all_interchain_gas_paymasters(chain_names.as_slice(), &metrics, db)
            .await?;
        let validator_announce = settings
            .build_validator_announce(&settings.originchainname, &core.metrics.clone())
            .await?;

        let whitelist = Arc::new(parse_matching_list(&settings.whitelist));
        let blacklist = Arc::new(parse_matching_list(&settings.blacklist));

        let skip_transaction_gas_limit_for = settings
            .skiptransactiongaslimitfor
            .map(|l| {
                l.split(',')
                    .map(|d| {
                        d.parse()
                            .expect("Error parsing domain id for transaction gas limit")
                    })
                    .collect()
            })
            .unwrap_or_default();

        let transaction_gas_limit = settings
            .transactiongaslimit
            .map(|l| l.parse())
            .transpose()
            .context("Invalid transaction gas limit")?;
        info!(
            %whitelist,
            %blacklist,
            ?transaction_gas_limit,
            ?skip_transaction_gas_limit_for,
            "Whitelist configuration"
        );

        let origin_chain = core
            .settings
            .chain_setup(&settings.originchainname)
            .context("Relayer must run on a configured chain")?
            .domain()?;

        let gas_enforcement_policies =
            parse_gas_enforcement_policies(&settings.gaspaymentenforcement);
        info!(?gas_enforcement_policies, "Gas enforcement configuration");

        let gas_payment_enforcer = Arc::new(GasPaymentEnforcer::new(
            gas_enforcement_policies,
            mailboxes.get(&origin_chain).unwrap().db().clone(),
            &settings.coingeckoapikey,
        ));

        Ok(Self {
            origin_chain,
            core,
            mailboxes,
            validator_announce,
            interchain_gas_paymasters,
            gas_payment_enforcer,
            whitelist,
            blacklist,
            transaction_gas_limit,
            skip_transaction_gas_limit_for,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let num_mailboxes = self.mailboxes.len();

        let mut tasks = Vec::with_capacity(num_mailboxes + 2);

        let prover_sync = Arc::new(RwLock::new(MerkleTreeBuilder::new(
            self.mailboxes.get(&self.origin_chain).unwrap().db().clone(),
        )));
        let mut send_channels: HashMap<u32, UnboundedSender<SubmitMessageArgs>> = HashMap::new();
        let destinations = self
            .mailboxes
            .keys()
            .filter(|c| **c != self.origin_chain)
            .collect::<Vec<&HyperlaneDomain>>();

        for chain in &destinations {
            let (send_channel, receive_channel): (
                UnboundedSender<SubmitMessageArgs>,
                UnboundedReceiver<SubmitMessageArgs>,
            ) = mpsc::unbounded_channel();
            let mailbox: &CachingMailbox = self.mailboxes.get(chain).unwrap();
            send_channels.insert(mailbox.domain().id(), send_channel);

            let chain_setup = self
                .core
                .settings
                .chain_setup(chain.name())
                .unwrap_or_else(|_| panic!("No chain setup found for {}", chain.name()))
                .clone();

            let txsubmission = chain_setup.txsubmission;
            let metadata_builder = MetadataBuilder::new(
                chain_setup,
                prover_sync.clone(),
                self.validator_announce.clone(),
                self.core.metrics.clone(),
            );
            tasks.push(self.run_destination_mailbox(
                mailbox.clone(),
                metadata_builder.clone(),
                txsubmission,
                self.core.settings.gelato.as_ref(),
                self.gas_payment_enforcer.clone(),
                receive_channel,
            ));
        }

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        tasks.push(self.run_origin_mailbox_sync(sync_metrics.clone()));

        let metrics =
            MessageProcessorMetrics::new(&self.core.metrics, &self.origin_chain, destinations);
        let message_processor = MessageProcessor::new(
            self.mailboxes.get(&self.origin_chain).unwrap().db().clone(),
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            prover_sync,
            send_channels,
        );
        tasks.push(self.run_message_processor(message_processor));

        tasks.push(self.run_interchain_gas_paymaster_sync(sync_metrics));

        run_all(tasks)
    }
}

impl Relayer {
    fn run_origin_mailbox_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let mailbox = self.mailboxes.get(&self.origin_chain).unwrap();
        let sync = mailbox.sync(
            self.as_ref().settings.chains[self.origin_chain.name()]
                .index
                .clone(),
            sync_metrics,
        );
        sync
    }

    fn run_interchain_gas_paymaster_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let paymaster = self
            .interchain_gas_paymasters
            .get(&self.origin_chain)
            .unwrap();
        let sync = paymaster.sync(
            self.as_ref().settings.chains[self.origin_chain.name()]
                .index
                .clone(),
            sync_metrics,
        );
        sync
    }

    /// Helper to construct a new GelatoSubmitter instance for submission to a
    /// particular mailbox.
    fn make_gelato_submitter(
        &self,
        message_receiver: UnboundedReceiver<SubmitMessageArgs>,
        mailbox: CachingMailbox,
        metadata_builder: MetadataBuilder,
        gelato_config: GelatoConf,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> GelatoSubmitter {
        let gelato_metrics =
            GelatoSubmitterMetrics::new(&self.core.metrics, &self.origin_chain, mailbox.domain());
        GelatoSubmitter::new(
            message_receiver,
            mailbox,
            metadata_builder,
            self.mailboxes.get(&self.origin_chain).unwrap().db().clone(),
            gelato_config,
            gelato_metrics,
            gas_payment_enforcer,
        )
    }

    fn run_message_processor(
        &self,
        message_processor: MessageProcessor,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let process_fut = message_processor.spawn();
        tokio::spawn(async move {
            let res = tokio::try_join!(process_fut)?;
            info!(?res, "try_join finished for message processor");
            Ok(())
        })
        .instrument(info_span!("run message processor"))
    }

    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(fields(destination=%destination_mailbox.domain()))]
    fn run_destination_mailbox(
        &self,
        destination_mailbox: CachingMailbox,
        metadata_builder: MetadataBuilder,
        tx_submission: TransactionSubmissionType,
        gelato_config: Option<&GelatoConf>,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
        msg_receive: UnboundedReceiver<SubmitMessageArgs>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let origin_mailbox = self.mailboxes.get(&self.origin_chain).unwrap();
        let destination = destination_mailbox.domain();

        let submit_fut = match tx_submission {
            TransactionSubmissionType::Gelato => {
                let gelato_config = gelato_config.unwrap_or_else(|| {
                    panic!(
                        "Expected GelatoConf for mailbox {} using Gelato",
                        destination
                    )
                });

                self.make_gelato_submitter(
                    msg_receive,
                    destination_mailbox.clone(),
                    metadata_builder,
                    gelato_config.clone(),
                    gas_payment_enforcer,
                )
                .spawn()
            }
            TransactionSubmissionType::Signer => {
                let transaction_gas_limit = if self
                    .skip_transaction_gas_limit_for
                    .contains(&destination.id())
                {
                    None
                } else {
                    self.transaction_gas_limit
                };
                let serial_submitter = SerialSubmitter::new(
                    msg_receive,
                    destination_mailbox.clone(),
                    metadata_builder,
                    origin_mailbox.db().clone(),
                    SerialSubmitterMetrics::new(
                        &self.core.metrics,
                        &self.origin_chain,
                        destination,
                    ),
                    gas_payment_enforcer,
                    transaction_gas_limit,
                );
                serial_submitter.spawn()
            }
        };

        tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut)?;
            info!(?res, "try_join finished for mailbox");
            Ok(())
        })
        .instrument(info_span!("run mailbox"))
    }
}

fn parse_matching_list(list: &Option<String>) -> MatchingList {
    list.as_deref()
        .map(serde_json::from_str)
        .transpose()
        .expect("Invalid matching list received")
        .unwrap_or_default()
}

fn parse_gas_enforcement_policies(policies: &str) -> Vec<GasPaymentEnforcementConfig> {
    serde_json::from_str(policies).expect("Invalid gas payment enforcement configuration received")
}

#[cfg(test)]
mod test {}
