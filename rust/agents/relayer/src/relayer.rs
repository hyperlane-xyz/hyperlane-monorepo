use std::sync::Arc;

use async_trait::async_trait;
use eyre::{bail, Result};
use tokio::{
    sync::mpsc,
    sync::watch::{Receiver, Sender},
    task::JoinHandle,
};
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_base::{
    chains::GelatoConf, AbacusAgentCore, Agent, CachingInterchainGasPaymaster, ContractSyncMetrics,
    InboxContracts, MultisigCheckpointSyncer,
};
use abacus_core::{AbacusCommon, AbacusContract, MultisigSignedCheckpoint, Signers, InboxValidatorManager};

use crate::msg::gelato_submitter::{GelatoSubmitter, GelatoSubmitterMetrics};
use crate::msg::processor::{MessageProcessor, MessageProcessorMetrics};
use crate::msg::serial_submitter::SerialSubmitter;
use crate::settings::whitelist::Whitelist;
use crate::settings::RelayerSettings;
use crate::{checkpoint_fetcher::CheckpointFetcher, msg::serial_submitter::SerialSubmitterMetrics};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    signed_checkpoint_polling_interval: u64,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    core: AbacusAgentCore,
    whitelist: Arc<Whitelist>,
}

impl AsRef<AbacusAgentCore> for Relayer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

#[async_trait]
#[allow(clippy::unit_arg)]
impl Agent for Relayer {
    const AGENT_NAME: &'static str = "relayer";

    type Settings = RelayerSettings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let multisig_checkpoint_syncer: MultisigCheckpointSyncer = settings
            .multisigcheckpointsyncer
            .try_into_multisig_checkpoint_syncer()?;
        let whitelist = Arc::new(
            settings
                .whitelist
                .as_ref()
                .map(|wl| serde_json::from_str(wl))
                .transpose()
                .expect("Invalid whitelist received")
                .unwrap_or_default(),
        );
        info!(whitelist = %whitelist, "Whitelist configuration");

        Ok(Self {
            signed_checkpoint_polling_interval: settings
                .signedcheckpointpollinginterval
                .parse()
                .unwrap_or(5),
            multisig_checkpoint_syncer,
            core: settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME, true)
                .await?,
            whitelist,
        })
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
        paymaster: Arc<CachingInterchainGasPaymaster>,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        paymaster.sync(self.as_ref().indexer.clone(), sync_metrics)
    }

    fn run_checkpoint_fetcher(
        &self,
        signed_checkpoint_sender: Sender<Option<MultisigSignedCheckpoint>>,
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

    #[tracing::instrument(fields(inbox=%inbox_contracts.inbox.chain_name()))]
    fn run_inbox(
        &self,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: Receiver<Option<MultisigSignedCheckpoint>>,
        gelato_conf: Option<GelatoConf>,
        signer: Option<Signers>,
    ) -> Result<Instrumented<JoinHandle<Result<()>>>> {
        let outbox = self.outbox().outbox();
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            outbox.chain_name(),
            inbox_contracts.inbox.chain_name(),
        );
        let (new_messages_send_channel, new_messages_receive_channel) = mpsc::unbounded_channel();
        let submit_fut = match gelato_conf {
            Some(cfg) if cfg.enabled_for_message_submission => {
                if signer.is_none() {
                    bail!("Need valid signer for inbox to create GelatoSubmitter, but none was available");
                }
                let gelato_submitter = GelatoSubmitter::new(
                    cfg,
                    new_messages_receive_channel,
                    inbox_contracts.clone(),
                    inbox_contracts.validator_manager.contract_address().unwrap(),
                    self.outbox().db(),
                    self.outbox().local_domain(),
                    signer.unwrap(),
                    GelatoSubmitterMetrics::new(
                        &self.core.metrics,
                        outbox.chain_name(),
                        inbox_contracts.inbox.chain_name(),
                    ),
                );
                gelato_submitter.spawn()
            }
            _ => {
                let serial_submitter = SerialSubmitter::new(
                    new_messages_receive_channel,
                    inbox_contracts.clone(),
                    self.outbox().db(),
                    SerialSubmitterMetrics::new(
                        &self.core.metrics,
                        outbox.chain_name(),
                        inbox_contracts.inbox.chain_name(),
                    ),
                );
                serial_submitter.spawn()
            }
        };
        let message_processor = MessageProcessor::new(
            outbox,
            self.outbox().db(),
            inbox_contracts,
            self.whitelist.clone(),
            metrics,
            new_messages_send_channel,
            signed_checkpoint_receiver,
        );
        info!(
            message_processor=?message_processor,
            "Using message processor"
        );
        let process_fut = message_processor.spawn();
        Ok(tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut, process_fut)?;
            info!(?res, "try_join finished for inbox");
            Ok(())
        })
        .instrument(info_span!("run inbox")))
    }

    pub async fn run(&self) -> Result<Instrumented<JoinHandle<Result<()>>>> {
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            tokio::sync::watch::channel::<Option<MultisigSignedCheckpoint>>(None);

        let mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = Vec::new();

        for (inbox_name, inbox_contracts) in self.inboxes() {
            let signer = self.core.settings.get_signer(inbox_name).await;
            let gelato_conf = self.core.settings.inboxes[inbox_name].gelato_conf.clone();
            tasks.push(self.run_inbox(
                inbox_contracts.clone(),
                signed_checkpoint_receiver.clone(),
                gelato_conf,
                signer,
            )?);
        }

        tasks.push(self.run_checkpoint_fetcher(signed_checkpoint_sender));

        let sync_metrics = ContractSyncMetrics::new(self.metrics());
        tasks.push(self.run_outbox_sync(sync_metrics.clone()));

        if let Some(paymaster) = self.interchain_gas_paymaster() {
            tasks.push(self.run_interchain_gas_paymaster_sync(paymaster, sync_metrics));
        } else {
            info!("Interchain Gas Paymaster not provided, not running sync");
        }

        Ok(self.run_all(tasks))
    }
}

#[cfg(test)]
mod test {}
