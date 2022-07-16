use std::collections::BinaryHeap;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{eyre, Result};
use tokio::{sync::mpsc, sync::watch, task::JoinHandle};
use tracing::error;
use tracing::{info, info_span, instrument::Instrumented, Instrument};

use abacus_base::{
    chains::GelatoConf, AbacusAgentCore, Agent, CachingInterchainGasPaymaster, ContractSyncMetrics,
    InboxContracts, MultisigCheckpointSyncer,
};
use abacus_core::{
    AbacusCommon, AbacusContract, Inbox, InboxValidatorManager, MultisigSignedCheckpoint, Signers,
};

use crate::msg::gelato_submitter::{GelatoSubmitter, GelatoSubmitterMetrics};
use crate::msg::processor::{MessageProcessor, MessageProcessorMetrics};
use crate::msg::serial_submitter::SerialSubmitter;
use crate::msg::SubmitMessageArgs;
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

    #[tracing::instrument(fields(inbox=%inbox_contracts.inbox.chain_name()))]
    fn run_inbox(
        &self,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
        gelato_conf: Option<&GelatoConf>,
        signer: Signers,
    ) -> Result<Instrumented<JoinHandle<Result<()>>>> {
        let (msg_send, msg_receive) = mpsc::unbounded_channel();
        let submit_fut = match gelato_conf {
            Some(cfg) if cfg.enabled => self
                .make_gelato_submitter_for_inbox(cfg, msg_receive, inbox_contracts.clone(), signer)?
                .spawn(),
            _ => self
                .make_serial_submitter_for_inbox(msg_receive, inbox_contracts.clone())?
                .spawn(),
        };
        let process_fut = self
            .make_message_processor_for_inbox(
                msg_send,
                signed_checkpoint_receiver,
                inbox_contracts.clone(),
            )?
            .spawn();
        // Run submit_fut and process_fut indefinitely, but if either fails or both complete,
        // log details and pass control flow to caller (we are probably shutting down or about
        // to panic).
        Ok(tokio::spawn(async move {
            let result = tokio::try_join!(submit_fut, process_fut)?;
            match result {
                (Ok(()), Ok(())) => Ok(()),
                (_, _) => {
                    error!(
                        "error with inbox tasks on '{}': '{:?}'",
                        inbox_contracts.inbox.chain_name(),
                        result
                    );
                    Err(eyre!("Missing attribute"))
                }
            }
        })
        .instrument(info_span!("run inbox")))
    }

    pub async fn run(&self) -> Result<Instrumented<JoinHandle<Result<()>>>> {
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            watch::channel::<Option<MultisigSignedCheckpoint>>(None);

        let mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = Vec::new();

        for (inbox_name, inbox_contracts) in self.inboxes() {
            let signer = self
                .core
                .settings
                .get_signer(inbox_name)
                .await
                .expect("get signer for inbox");
            tasks.push(self.run_inbox(
                inbox_contracts.clone(),
                signed_checkpoint_receiver.clone(),
                self.core.settings.inboxes[inbox_name].gelato_conf.as_ref(),
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

    fn make_gelato_submitter_for_inbox(
        &self,
        cfg: &GelatoConf,
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
        signer: Signers,
    ) -> Result<GelatoSubmitter> {
        let metrics = GelatoSubmitterMetrics::new(
            &self.core.metrics,
            self.outbox().outbox().chain_name(),
            inbox_contracts.inbox.chain_name(),
        );
        Ok(GelatoSubmitter {
            messages: message_receiver,
            outbox_domain: self.outbox().local_domain(),
            inbox_domain: inbox_contracts.inbox.local_domain(),
            inbox_address: inbox_contracts.inbox.contract_address().into(),
            ivm_address: inbox_contracts.validator_manager.contract_address().into(),
            sponsor_address: cfg.sponsor_address,
            _db: self.outbox().db(),
            signer,
            http: reqwest::Client::new(),
            _metrics: metrics,
        })
    }

    fn make_serial_submitter_for_inbox(
        &self,
        message_receiver: mpsc::UnboundedReceiver<SubmitMessageArgs>,
        inbox_contracts: InboxContracts,
    ) -> Result<SerialSubmitter> {
        let metrics = SerialSubmitterMetrics::new(
            &self.core.metrics,
            self.outbox().outbox().chain_name(),
            inbox_contracts.inbox.chain_name(),
        );
        Ok(SerialSubmitter {
            inbox_chain_name: inbox_contracts.inbox.chain_name().into(),
            inbox: inbox_contracts.inbox.clone(),
            ivm: inbox_contracts.validator_manager.clone(),
            message_receiver,
            wait_queue: Vec::default(),
            run_queue: BinaryHeap::new(),
            db: self.outbox().db(),
            metrics,
        })
    }

    fn make_message_processor_for_inbox(
        &self,
        message_sender: mpsc::UnboundedSender<SubmitMessageArgs>,
        signed_checkpoint_receiver: watch::Receiver<Option<MultisigSignedCheckpoint>>,
        inbox_contracts: InboxContracts,
    ) -> Result<MessageProcessor> {
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            self.outbox().outbox().chain_name(),
            inbox_contracts.inbox.chain_name(),
        );
        Ok(MessageProcessor::new(
            self.outbox().outbox(),
            self.outbox().db(),
            inbox_contracts,
            self.whitelist.clone(),
            metrics,
            message_sender,
            signed_checkpoint_receiver,
        ))
    }
}

#[cfg(test)]
mod test {}
