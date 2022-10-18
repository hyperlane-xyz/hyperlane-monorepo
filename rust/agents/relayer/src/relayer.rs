use std::sync::Arc;
use std::time::Duration;

use abacus_base::chains::TransactionSubmissionType;
use async_trait::async_trait;
use eyre::Result;
use tokio::time::MissedTickBehavior;
use tokio::{sync::mpsc, sync::watch, task::JoinHandle};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_base::{
    chains::GelatoConf, run_all, AbacusAgentCore, Agent, BaseAgent, CachingInterchainGasPaymaster,
    ContractSyncMetrics, CoreMetrics, InboxContracts, MultisigCheckpointSyncer,
};
use abacus_core::{AbacusContract, MultisigSignedCheckpoint, Signers};

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
    signed_checkpoint_polling_interval: u64,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    core: AbacusAgentCore,
    gas_payment_enforcement_policy: GasPaymentEnforcementPolicy,
    whitelist: Arc<MatchingList>,
    blacklist: Arc<MatchingList>,
}

impl AsRef<AbacusAgentCore> for Relayer {
    fn as_ref(&self) -> &AbacusAgentCore {
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
        let core = settings
            .as_ref()
            .try_into_abacus_core(metrics, true)
            .await?;

        let multisig_checkpoint_syncer: MultisigCheckpointSyncer = settings
            .multisigcheckpointsyncer
            .try_into_multisig_checkpoint_syncer(
                core.outbox.outbox().chain_name(),
                core.metrics.validator_checkpoint_index(),
            )?;

        let whitelist = parse_matching_list(&settings.whitelist);
        let blacklist = parse_matching_list(&settings.blacklist);
        info!(whitelist = %whitelist, blacklist = %blacklist, "Whitelist configuration");

        Ok(Self {
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

        let inboxes = self.inboxes();

        let mut tasks = Vec::with_capacity(inboxes.len() + 3);

        let gas_payment_enforcer = Arc::new(GasPaymentEnforcer::new(
            self.gas_payment_enforcement_policy.clone(),
            self.outbox().db().clone(),
        ));

        for (inbox_name, inbox_contracts) in inboxes {
            let signer = self
                .core
                .settings
                .chain
                .get_signer(inbox_name)
                .await
                .expect("expected signer for inbox");
            tasks.push(self.run_inbox(
                inbox_contracts.clone(),
                signed_checkpoint_receiver.clone(),
                self.core.settings.chain.inboxes[inbox_name].txsubmission,
                self.core.settings.chain.gelato.as_ref(),
                signer,
                gas_payment_enforcer.clone(),
            ));
        }

        tasks.push(self.run_checkpoint_fetcher(signed_checkpoint_sender));

        let sync_metrics = ContractSyncMetrics::new(self.core.metrics.clone());
        tasks.push(self.run_outbox_sync(sync_metrics.clone()));

        if let Some(paymaster) = self.interchain_gas_paymaster() {
            tasks.push(self.run_interchain_gas_paymaster_sync(paymaster.clone(), sync_metrics));
        } else {
            info!("Interchain Gas Paymaster not provided, not running sync");
        }

        tasks.push(self.run_outbox_metrics_loop());

        run_all(tasks)
    }
}

impl Relayer {
    fn run_outbox_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let sync = outbox.sync(self.as_ref().indexer.clone(), sync_metrics);
        sync
    }

    fn run_interchain_gas_paymaster_sync(
        &self,
        paymaster: CachingInterchainGasPaymaster,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        paymaster.sync(self.as_ref().indexer.clone(), sync_metrics)
    }

    fn run_checkpoint_fetcher(
        &self,
        signed_checkpoint_sender: watch::Sender<Option<MultisigSignedCheckpoint>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let checkpoint_fetcher = CheckpointFetcher::new(
            self.outbox().outbox(),
            self.signed_checkpoint_polling_interval,
            self.multisig_checkpoint_syncer.clone(),
            signed_checkpoint_sender,
            self.core.metrics.last_known_message_leaf_index(),
        );
        checkpoint_fetcher.spawn()
    }

    fn run_outbox_metrics_loop(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox().outbox().clone();
        let outbox_name = outbox.chain_name();
        let outbox_state_gauge = self
            .core
            .metrics
            .outbox_state()
            .with_label_values(&[outbox_name]);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60 * 10));
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                let state = outbox.state().await;
                match &state {
                    Ok(state) => outbox_state_gauge.set(*state as u8 as i64),
                    Err(e) => tracing::warn!(error = %e, "Failed to get outbox state"),
                };

                interval.tick().await;
            }
        })
        .instrument(info_span!("outbox_metrics_loop"))
    }

    /// Helper to construct a new GelatoSubmitter instance for submission to a
    /// particular inbox.
    fn make_gelato_submitter_for_inbox(
        &self,
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        gelato_config: GelatoConf,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> GelatoSubmitter {
        let inbox_chain_name = inbox_contracts.inbox.chain_name().to_owned();
        GelatoSubmitter::new(
            message_receiver,
            inbox_contracts,
            self.outbox().db().clone(),
            gelato_config,
            GelatoSubmitterMetrics::new(
                &self.core.metrics,
                self.outbox().outbox().chain_name(),
                &inbox_chain_name,
            ),
            gas_payment_enforcer,
        )
    }

    #[tracing::instrument(fields(inbox=%inbox_contracts.inbox.chain_name()))]
    fn run_inbox(
        &self,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
        tx_submission: TransactionSubmissionType,
        gelato_config: Option<&GelatoConf>,
        signer: Signers,
        gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox().outbox();
        let outbox_name = outbox.chain_name();
        let inbox_name = inbox_contracts.inbox.chain_name();
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            outbox_name,
            inbox_contracts.inbox.chain_name(),
        );
        let (msg_send, msg_receive) = mpsc::unbounded_channel();

        let submit_fut = match tx_submission {
            TransactionSubmissionType::Gelato => {
                let gelato_config = gelato_config.unwrap_or_else(|| {
                    panic!("Expected GelatoConf for inbox {} using Gelato", inbox_name)
                });

                self.make_gelato_submitter_for_inbox(
                    msg_receive,
                    inbox_contracts.clone(),
                    gelato_config.clone(),
                    gas_payment_enforcer,
                )
                .spawn()
            }
            TransactionSubmissionType::Signer => {
                let serial_submitter = SerialSubmitter::new(
                    msg_receive,
                    inbox_contracts.clone(),
                    self.outbox().db().clone(),
                    SerialSubmitterMetrics::new(
                        &self.core.metrics,
                        outbox_name,
                        inbox_contracts.inbox.chain_name(),
                    ),
                    gas_payment_enforcer,
                );
                serial_submitter.spawn()
            }
        };

        let message_processor = MessageProcessor::new(
            self.outbox().db().clone(),
            inbox_contracts,
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
            info!(?res, "try_join finished for inbox");
            Ok(())
        })
        .instrument(info_span!("run inbox"))
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
