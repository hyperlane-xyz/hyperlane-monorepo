use std::{
    collections::HashSet,
    fmt::Debug,
    hash::Hash,
    time::Duration,
};

use eyre::Result as EyreResult;
use hyperlane_core::{
    ChainResult, HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, Indexed, LogMeta, Mailbox,
    MultisigSignedCheckpoint, TxOutcome,
};
use tokio::{task::JoinHandle, time};
use tokio_metrics::TaskMonitor;
use tracing::{info, info_span, warn, Instrument};

use dym_kas_core::deposit::DepositFXG;
use dym_kas_relayer::deposit::on_new_deposit;
use dymension_kaspa::{Deposit, KaspaProvider, ValidatorsClient};

use crate::{contract_sync::cursors::Indexable, db::HyperlaneRocksDB};

struct DepositCache {
    seen: HashSet<Deposit>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
        }
    }

    fn has_seen(&self, deposit: &Deposit) -> bool {
        self.seen.contains(deposit)
    }

    fn mark_as_seen(&mut self, deposit: Deposit) {
        self.seen.insert(deposit);
    }
}

pub trait MetadataConstructor {
    fn metadata(&self, checkpoint: &MultisigSignedCheckpoint) -> EyreResult<Vec<u8>>;
}

pub struct Foo<M: Mailbox, C: MetadataConstructor> {
    domain: HyperlaneDomain,
    kdb: HyperlaneRocksDB,
    provider: KaspaProvider,
    hub_mailbox: M,
    metadata_constructor: C,
    deposit_cache: DepositCache,
}

impl<M: Mailbox, C: MetadataConstructor> Foo<M, C>
where
    M: Send + Sync + 'static,
    C: Send + Sync + 'static,
{
    pub fn new(
        domain: HyperlaneDomain,
        kdb: HyperlaneRocksDB,
        provider: KaspaProvider,
        hub_mailbox: M,
        metadata_constructor: C,
    ) -> Self {
        Self {
            domain,
            kdb,
            provider,
            hub_mailbox,
            metadata_constructor,
            deposit_cache: DepositCache::new(),
        }
    }

    pub fn run(mut self, task_monitor: TaskMonitor) -> JoinHandle<()> {
        let name = "foo";
        tokio::task::Builder::new()
            .name(name)
            .spawn(TaskMonitor::instrument(
                &task_monitor,
                async move {
                    self.kas_monitor_task().await;
                }
                .instrument(info_span!("Kaspa Monitor")),
            ))
            .expect("Failed to spawn kaspa monitor task")
    }

    async fn kas_monitor_task(&mut self) {
        self.run_monitor().await;
    }

    // https://github.com/dymensionxyz/hyperlane-monorepo/blob/20b9e669afcfb7728e66b5932e85c0f7fcbd50c1/dymension/libs/kaspa/lib/relayer/note.md#L102-L119
    async fn run_monitor(&mut self) {
        loop {
            let deposits = self.provider.rest().get_deposits().await.unwrap();
            self.handle_observed_deposits(deposits).await;
            // let logs = self.deposits_to_logs::<HyperlaneMessage>(deposits).await;
            // let stored= self.dedupe_and_store_logs(&self.kdb, logs).await;
            // unimplemented!()
            time::sleep(Duration::from_secs(10)).await;
        }
    }

    pub async fn handle_observed_deposits(&mut self, deposits: Vec<Deposit>) {
        let new_deposits: Vec<Deposit> = deposits
            .into_iter()
            .filter(|deposit| !self.deposit_cache.has_seen(deposit))
            .collect::<Vec<_>>();

        for deposit in &new_deposits {
            self.deposit_cache.mark_as_seen(deposit.clone());
            info!("FOOX: New deposit: {:?}", deposit);
        }

        for deposit in &new_deposits {
            if let Some(fxg) = on_new_deposit(deposit) {
                // local call to F()
                let _res = self.gather_sigs_and_send_to_hub(&fxg).await;
            }
        }
    }

    async fn gather_sigs_and_send_to_hub(&self, fxg: &DepositFXG) -> ChainResult<TxOutcome> {
        // need to ultimately send to https://github.com/dymensionxyz/hyperlane-monorepo/blob/1a603d65e0073037da896534fc52da4332a7a7b1/rust/main/chains/hyperlane-cosmos-native/src/mailbox.rs#L131
        let m: HyperlaneMessage = HyperlaneMessage::default(); // TODO: from depositsfx
        let mut sigs_res = self.provider.validators().get_deposit_sigs(fxg).await?;

        // let checkpoint: MultisigSignedCheckpoint = sigs_res.try_into()?;
        let checkpoint: MultisigSignedCheckpoint =
            MultisigSignedCheckpoint::try_from(&mut sigs_res).unwrap();
        // let metadata = MultisigMetadata::new(checkpoint, 0, None);
        let _threshold = 3usize; // TODO: threshold check
        let metadata = self.metadata_constructor.metadata(&checkpoint)?;

        let slice = metadata.as_slice();

        self.hub_mailbox.process(&m, slice, None).await
    }

    /*
    Metadata construction:
        Need to mimic https://github.com/dymensionxyz/hyperlane-monorepo/blob/f4836a2a7291864d0c1850dbbcecd6af54addce3/rust/main/hyperlane-base/src/types/multisig.rs#L167
     */

    /*
    We circumvent the ticker of the processor loop
        https://github.com/dymensionxyz/hyperlane-monorepo/blob/bb9df82a19c0583b994adbb40436168a55b8442e/rust/main/agents/relayer/src/msg/processor.rs#L254
        Because it would be a lot of work to fully integrate into it, and it probably has assumptions that would be tricky for us to satisfy (nonce etc)
        Instead we use the pending message builder and the metadata construction from that, and then do a direct chain send
     */

    async fn deposits_to_logs<T>(&self, _deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
    {
        vec![]
        // unimplemented!()
    }

    async fn dedupe_and_store_logs<T, S>(
        &self,
        store: &S,
        logs: Vec<(Indexed<T>, LogMeta)>,
    ) -> Vec<(Indexed<T>, LogMeta)>
    where
        T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
        S: HyperlaneLogStore<T> + Clone + 'static,
    {
        // TODO: need to lock store?
        let deduped_logs = HashSet::<_>::from_iter(logs);
        let logs = Vec::from_iter(deduped_logs);

        if let Err(err) = store.store_logs(&logs).await {
            warn!(?err, "Error storing logs in db");
        }

        logs
    }
}