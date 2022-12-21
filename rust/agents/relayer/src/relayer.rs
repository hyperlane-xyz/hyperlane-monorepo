use std::sync::Arc;

use async_trait::async_trait;
use eyre::{Context, Result};
use tokio::{sync::mpsc, sync::watch, task::JoinHandle};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use hyperlane_base::chains::TransactionSubmissionType;
use hyperlane_base::CachingMailbox;
use hyperlane_base::{
    chains::GelatoConf, run_all, Agent, BaseAgent, ContractSyncMetrics, CoreMetrics,
    HyperlaneAgentCore, MultisigCheckpointSyncer,
};
use hyperlane_core::{HyperlaneChain, HyperlaneDomain, MultisigIsm, MultisigSignedCheckpoint};

use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::msg::gelato_submitter::{GelatoSubmitter, GelatoSubmitterMetrics};
use crate::msg::processor::{MessageProcessor, MessageProcessorMetrics};
use crate::msg::serial_submitter::SerialSubmitter;
use crate::msg::SubmitMessageArgs;
use crate::settings::matching_list::MatchingList;
use crate::settings::{GasPaymentEnforcementPolicy, RelayerSettings};
use crate::{checkpoint_fetcher::CheckpointFetcher, msg::serial_submitter::SerialSubmitterMetrics};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    origin_chain: HyperlaneDomain,
    signed_checkpoint_polling_interval: u64,
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
        let core = settings.build_hyperlane_core(metrics, None).await?;

        let multisig_checkpoint_syncer = settings.multisigcheckpointsyncer.build(
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
            signed_checkpoint_polling_interval: settings
                .signedcheckpointpollinginterval
                .parse()
                .unwrap_or(5),
            multisig_checkpoint_syncer,
            core,
            gas_payment_enforcement_policy: settings.gaspaymentenforcementpolicy,
            whitelist,
            blacklist,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            watch::channel::<Option<MultisigSignedCheckpoint>>(None);

        let num_mailboxes = self.core.mailboxes.len();

        let mut tasks = Vec::with_capacity(num_mailboxes + 2);

        let gas_payment_enforcer = Arc::new(GasPaymentEnforcer::new(
            self.gas_payment_enforcement_policy.clone(),
            self.mailbox(&self.origin_chain).unwrap().db().clone(),
        ));

        for chain in self.core.mailboxes.keys() {
            if *chain == self.origin_chain {
                continue;
            }
            let mailbox = self.mailbox(chain).unwrap();
            let multisig_ism = self.multisig_ism(chain).unwrap();

            tasks.push(self.run_destination_mailbox(
                mailbox.clone(),
                multisig_ism.clone(),
                signed_checkpoint_receiver.clone(),
                self.core.settings.chains[chain.name()].txsubmission,
                self.core.settings.gelato.as_ref(),
                gas_payment_enforcer.clone(),
            ));
        }

        tasks.push(self.run_checkpoint_fetcher(signed_checkpoint_sender));

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        tasks.push(self.run_origin_mailbox_sync(sync_metrics.clone()));

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

    fn run_checkpoint_fetcher(
        &self,
        signed_checkpoint_sender: watch::Sender<Option<MultisigSignedCheckpoint>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let checkpoint_fetcher = CheckpointFetcher::new(
            self.mailbox(&self.origin_chain).unwrap(),
            self.signed_checkpoint_polling_interval,
            self.multisig_checkpoint_syncer.clone(),
            signed_checkpoint_sender,
            self.core.metrics.last_known_message_nonce(),
        );
        checkpoint_fetcher.spawn()
    }

    /// Helper to construct a new GelatoSubmitter instance for submission to a
    /// particular mailbox.
    fn make_gelato_submitter(
        &self,
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        mailbox: CachingMailbox,
        multisig_ism: Arc<dyn MultisigIsm>,
        gelato_config: GelatoConf,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> GelatoSubmitter {
        let gelato_metrics =
            GelatoSubmitterMetrics::new(&self.core.metrics, &self.origin_chain, mailbox.domain());
        GelatoSubmitter::new(
            message_receiver,
            mailbox,
            multisig_ism,
            self.mailbox(&self.origin_chain).unwrap().db().clone(),
            gelato_config,
            gelato_metrics,
            gas_payment_enforcer,
        )
    }

    #[allow(clippy::too_many_arguments)]
    #[tracing::instrument(fields(destination=%destination_mailbox.domain()))]
    fn run_destination_mailbox(
        &self,
        destination_mailbox: CachingMailbox,
        multisig_ism: Arc<dyn MultisigIsm>,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
        tx_submission: TransactionSubmissionType,
        gelato_config: Option<&GelatoConf>,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let origin_mailbox = self.mailbox(&self.origin_chain).unwrap();
        let destination = destination_mailbox.domain();
        let metrics =
            MessageProcessorMetrics::new(&self.core.metrics, &self.origin_chain, destination);
        let (msg_send, msg_receive) = mpsc::unbounded_channel();

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
                    multisig_ism,
                    gelato_config.clone(),
                    gas_payment_enforcer,
                )
                .spawn()
            }
            TransactionSubmissionType::Signer => {
                let serial_submitter = SerialSubmitter::new(
                    msg_receive,
                    destination_mailbox.clone(),
                    multisig_ism,
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

        let message_processor = MessageProcessor::new(
            origin_mailbox.db().clone(),
            destination_mailbox,
            self.whitelist.clone(),
            self.blacklist.clone(),
            metrics,
            msg_send,
            signed_checkpoint_receiver,
        );
        info!(
            message_processor=?message_processor,
            "Using message processor"
        );
        let process_fut = message_processor.spawn();
        tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut, process_fut)?;
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
