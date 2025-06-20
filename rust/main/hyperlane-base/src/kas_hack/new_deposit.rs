use crate::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore};
use tracing::{info, warn};

use dym_kas_core::deposit::DepositFXG;
use dym_kas_relayer::deposit::on_new_deposit;
use dymension_kaspa::{Deposit, RestProvider, ValidatorsClient};

use hyperlane_core::{
    traits::PendingOperationResult, traits::TxOutcome, ChainCommunicationError, ChainResult,
    HyperlaneMessage, Indexed, LogMeta, Mailbox, MultisigSignedCheckpoint,
    MultisigSignedCheckpointError, SignedCheckpointWithMessageId,
};
use eyre::Result as EyreResult;
use std::{collections::HashSet, fmt::Debug, hash::Hash};

pub struct DepositCache {
    seen: HashSet<Deposit>,
}

impl DepositCache {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
        }
    }
}

pub async fn handle_observed_deposits(
    validators_client: &ValidatorsClient,
    cache: &mut DepositCache,
    deposits: Vec<Deposit>,
    hub_mailbox: &M,
) {
    let new_deposits: Vec<Deposit> = deposits
        .into_iter()
        .filter(|deposit| !cache.seen.contains(deposit))
        .collect::<Vec<_>>();
    for deposit in &new_deposits {
        cache.seen.insert(deposit.clone());
        info!("FOOX: New deposit: {:?}", deposit);
    }

    for deposit in &new_deposits {
        let fxg = on_new_deposit(deposit); // local call to F()
        if let Some(fxg) = fxg {
            let res = gather_sigs_and_send_to_hub(validators_client, hub_mailbox, &fxg).await;
        }
    }
}

async fn gather_sigs_and_send_to_hub<M: Mailbox, C: MetadataConstructor>(
    validators_client: &ValidatorsClient,
    hub_mailbox: &M,
    metadata_constructor: &C,
    fxg: &DepositFXG,
) -> ChainResult<TxOutcome> {
    // need to ultimately send to https://github.com/dymensionxyz/hyperlane-monorepo/blob/1a603d65e0073037da896534fc52da4332a7a7b1/rust/main/chains/hyperlane-cosmos-native/src/mailbox.rs#L131
    let m: HyperlaneMessage = HyperlaneMessage::default(); // TODO: from depositsfx
    let sigs_res = validators_client.get_deposit_sigs(&fxg).await?;



    let checkpoint: MultisigSignedCheckpoint = sigs_res.try_into()?;
    // let metadata = MultisigMetadata::new(checkpoint, 0, None);
    let threshold = 3usize; // TODO: threshold check
    let metadata = metadata_constructor.metadata(&checkpoint)?;

    let outcome = hub_mailbox.process(&m, &[], None).await?;
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
pub trait MetadataConstructor {
    fn metadata(
        &self,
        checkpoint: &MultisigSignedCheckpoint,
    ) -> EyreResult<Vec<u8>>;
}

pub async fn deposits_to_logs<T>(deposits: Vec<Deposit>) -> Vec<(Indexed<T>, LogMeta)>
where
    T: Indexable + Debug + Send + Sync + Clone + Eq + Hash + 'static,
{
    return vec![];
    // unimplemented!()
}

pub async fn dedupe_and_store_logs<T, S>(
    _domain: &HyperlaneDomain,
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

    let _stored = match store.store_logs(&logs).await {
        Ok(stored) => stored,
        Err(err) => {
            warn!(?err, "Error storing logs in db");
            Default::default()
        }
    };

    logs
}
