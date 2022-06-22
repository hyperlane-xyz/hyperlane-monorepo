use std::sync::mpsc::channel;
use std::sync::Arc;

use async_trait::async_trait;
use eyre::{Context, Result, WrapErr};
use futures_util::{try_join, Future};
use tokio::{
    sync::{
        futures, mpsc, watch,
        watch::{Receiver, Sender},
    },
    task::JoinHandle,
};
use tracing::{info, info_span, instrument::Instrumented, warn, Instrument};

use abacus_base::{
    chains::GelatoConf, AbacusAgentCore, Agent, CachingInterchainGasPaymaster, ContractSyncMetrics,
    InboxContracts, MultisigCheckpointSyncer,
};
use abacus_core::{AbacusContract, MultisigSignedCheckpoint};

use crate::checkpoint_fetcher::CheckpointFetcher;
use crate::message_processor::MessageProcessorMetrics;
use crate::settings::whitelist::Whitelist;
use crate::{message_processor::MessageProcessor, settings::RelayerSettings};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SubmitMessageOp {
    // TODO(webbhorn): Elsewhere in e.g. message_processor.rs, u32 is
    // used to represent leaf index, but isn't that too narrow? In
    // some places we use H256 which seems more intuitively right.
    pub leaf_index: u32,
}

#[derive(Debug)]
pub enum MessageSubmitter {
    SerialWithProvider(mpsc::Receiver<SubmitMessageOp>),
    GelatoSubmitter(mpsc::Receiver<SubmitMessageOp>),
    // Potential future Submitters:
    //
    // - BatchingMessagesSubmitter
    //
    // - ShardedWalletSubmitter (to get parallelism / nonce)
    //
    // - SpeculativeSerializedSubmitter (batches with higher optimistic
    // - nonces, recovery behavior)
    //
    // - FallbackProviderSubmitter (Serialized, but if some RPC provider sucks,
    //   switch everyone to new one)
}

impl MessageSubmitter {
    fn new(gelato_cfg: Option<GelatoConf>, rx: mpsc::Receiver<SubmitMessageOp>) -> Self {
        if gelato_cfg.is_none() {
            return MessageSubmitter::SerialWithProvider(rx);
        }
        MessageSubmitter::GelatoSubmitter(rx)
    }
    fn spawn(self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("submitter work loop"))
    }
    async fn work_loop(&self) -> Result<()> {
        match self {
            Self::SerialWithProvider(rx) => {
                // TODO(webbhorn):
                // - ===> Waiting for validation checkpoint queue
                // - ===> Waiting for funding queue
                // - ===> Send queue
                // - Forever:
                //   -  Pull rx work
                //   -  Categorize new work into ckpt_q, fund_q, or send_q.
                //   -  Move work through queues
                //   -  Pick next ready work that sorts best for some queue metric
                //      (most recent)?
                for _ in 0..100 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                }
                Ok(())
            },
            Self::GelatoSubmitter(rx) => {
                // TODO(webbhorn):
                // - While rx has work
                //   -  Spawn a top-level tokio task to run the ForwardGelatoOp
                //      to completion.
                for _ in 0..100 {
                    tokio::time::sleep(tokio::time::Duration::from_millis(1000)).await;
                }
                Ok(())
            }
        }
    }
}

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    signed_checkpoint_polling_interval: u64,
    max_processing_retries: u32,
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
            max_processing_retries: settings.maxprocessingretries.parse().unwrap_or(10),
            multisig_checkpoint_syncer,
            core: settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME)
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

    fn run_inbox(
        &self,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: Receiver<Option<MultisigSignedCheckpoint>>,
        gelato_conf: Option<GelatoConf>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let db = self.outbox().db();
        let outbox = self.outbox().outbox();
        let metrics = MessageProcessorMetrics::new(
            &self.core.metrics,
            outbox.chain_name(),
            inbox_contracts.inbox.chain_name(),
        );
        info!(
            name=%inbox_contracts.inbox,
            db=?db,
            outbox=?outbox,
            metrics=?metrics,
            gelato=?gelato_conf,
            "running inbox message processor and submit worker"
        );

        let (snd, rcv) = tokio::sync::mpsc::channel(1000);

        let submitter = MessageSubmitter::new(gelato_conf, rcv);
        info!(submitter=?submitter, "using submitter");
        let submit_fut = tokio::spawn(async move { submitter.spawn() });

        let message_processor = MessageProcessor::new(
            outbox,
            self.max_processing_retries.clone(),
            db,
            inbox_contracts,
            signed_checkpoint_receiver,
            self.whitelist.clone(),
            metrics,
            snd,
        );
        info!(
            message_processor=?message_processor,
            "using message processor"
        );
        let process_fut = tokio::spawn(message_processor.spawn());

        tokio::spawn(async move {
            let res = tokio::try_join!(submit_fut, process_fut)?;
            info!(?res, "try_join finished for inbox");
            Ok(())
        })
        .instrument(info_span!("run inbox"))
    }

    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            tokio::sync::watch::channel::<Option<MultisigSignedCheckpoint>>(None);

        let mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox_contracts)| {
                self.run_inbox(
                    inbox_contracts.clone(),
                    signed_checkpoint_receiver.clone(),
                    self.core.settings.inboxes[inbox_name].gelato_conf.clone(),
                )
            })
            .collect();

        tasks.push(self.run_checkpoint_fetcher(signed_checkpoint_sender));

        let sync_metrics = ContractSyncMetrics::new(self.metrics());
        tasks.push(self.run_outbox_sync(sync_metrics.clone()));

        if let Some(paymaster) = self.interchain_gas_paymaster() {
            tasks.push(self.run_interchain_gas_paymaster_sync(paymaster, sync_metrics));
        } else {
            info!("Interchain Gas Paymaster not provided, not running sync");
        }

        self.run_all(tasks)
    }
}

#[cfg(test)]
mod test {}
