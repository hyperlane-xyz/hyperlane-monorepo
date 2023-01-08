use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{Context, Result};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::{sync::mpsc, task::JoinHandle};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::chains::TransactionSubmissionType;
use hyperlane_base::CachingMailbox;
use hyperlane_base::{
    chains::GelatoConf, run_all, Agent, BaseAgent, ContractSyncMetrics, CoreMetrics,
    HyperlaneAgentCore, MultisigCheckpointSyncer,
};
use hyperlane_core::{HyperlaneChain, HyperlaneDomain};

use tokio::sync::RwLock;

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::msg::gelato_submitter::{GelatoSubmitter, GelatoSubmitterMetrics};
use crate::msg::processor::{MessageProcessor, MessageProcessorMetrics};
use crate::msg::serial_submitter::SerialSubmitter;
use crate::msg::serial_submitter::SerialSubmitterMetrics;
use crate::msg::{metadata_builder::MetadataBuilder, SubmitMessageArgs};
use crate::settings::matching_list::MatchingList;
use crate::settings::{GasPaymentEnforcementPolicy, RelayerSettings};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    origin_chain: HyperlaneDomain,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    core: HyperlaneAgentCore,
    gas_payment_enforcement_policy: GasPaymentEnforcementPolicy,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
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
        let core = if let Some(ref remotes) = settings.remotechainnames {
            let mut v: Vec<&str> = remotes.iter().map(|x| x.as_str()).collect();
            v.push(&settings.originchainname);
            settings.try_into_hyperlane_core(metrics, Some(v.clone())).await?
        } else {
            settings.try_into_hyperlane_core(metrics, None).await?
        };

        let multisig_checkpoint_syncer: MultisigCheckpointSyncer = settings
            .multisigcheckpointsyncer
            .try_into_multisig_checkpoint_syncer(
                &settings.originchainname,
                core.metrics.validator_checkpoint_index(),
            )?;

        let whitelist = parse_matching_list(&settings.whitelist);
        let blacklist = parse_matching_list(&settings.blacklist);
        info!(whitelist = %whitelist, blacklist = %blacklist, "Whitelist configuration");

        let origin_chain = core
            .settings
            .chain_setup(&settings.originchainname)
            .context("Relayer must run on a configured chain")?
            .domain()?;

        Ok(Self {
            origin_chain,
            multisig_checkpoint_syncer,
            core,
            gas_payment_enforcement_policy: settings.gaspaymentenforcementpolicy,
            whitelist,
            blacklist,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let num_mailboxes = self.core.mailboxes.len();

        let mut tasks = Vec::with_capacity(num_mailboxes + 2);

        let gas_payment_enforcer = Arc::new(GasPaymentEnforcer::new(
            self.gas_payment_enforcement_policy.clone(),
            self.mailbox(&self.origin_chain).unwrap().db().clone(),
        ));

        let prover_sync = Arc::new(RwLock::new(MerkleTreeBuilder::new(
            self.mailbox(&self.origin_chain).unwrap().db().clone(),
        )));
        let mut send_channels: HashMap<u32, UnboundedSender<SubmitMessageArgs>> = HashMap::new();
        let destinations = self
            .core
            .mailboxes
            .keys()
            .filter(|c| **c != self.origin_chain)
            .collect::<Vec<&HyperlaneDomain>>();

        for chain in &destinations {
            let (send_channel, receive_channel): (
                UnboundedSender<SubmitMessageArgs>,
                UnboundedReceiver<SubmitMessageArgs>,
            ) = mpsc::unbounded_channel();
            let mailbox = self.mailbox(chain).unwrap();
            send_channels.insert(mailbox.domain().id(), send_channel);

            let chain_setup = self
                .core
                .settings
                .chain_setup(chain.name())
                .unwrap_or_else(|_| panic!("No chain setup found for {}", chain.name()));

            let metadata_builder = MetadataBuilder::new(
                self.core.metrics.clone(),
                self.core.settings.get_signer(chain.name()).await,
                chain_setup.clone(),
                self.multisig_checkpoint_syncer.clone(),
                prover_sync.clone(),
            );
            tasks.push(self.run_destination_mailbox(
                mailbox.clone(),
                metadata_builder.clone(),
                chain_setup.txsubmission,
                self.core.settings.gelato.as_ref(),
                gas_payment_enforcer.clone(),
                receive_channel,
            ));
        }

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        tasks.push(self.run_origin_mailbox_sync(sync_metrics.clone()));

        let metrics =
            MessageProcessorMetrics::new(&self.core.metrics, &self.origin_chain, destinations);
        let message_processor = MessageProcessor::new(
            self.mailbox(&self.origin_chain).unwrap().db().clone(),
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            prover_sync.clone(),
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
        let mailbox = self.mailbox(&self.origin_chain).unwrap();
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
        let paymaster = self.interchain_gas_paymaster(&self.origin_chain).unwrap();
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
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
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
            self.mailbox(&self.origin_chain).unwrap().db().clone(),
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
        let origin_mailbox = self.mailbox(&self.origin_chain).unwrap();
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

fn parse_matching_list(list: &Option<String>) -> Arc<MatchingList> {
    Arc::new(
        list.as_deref()
            .map(serde_json::from_str)
            .transpose()
            .expect("Invalid matching list received")
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod test {}
