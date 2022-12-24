use std::collections::{hash_map::Entry, HashMap};

use ethers::prelude::Address;
use eyre::Result;
use tracing::{debug, instrument, warn};

use hyperlane_core::{MultisigSignedCheckpoint, SignedCheckpointWithSigner, H160, H256};

use crate::{CheckpointSyncer, CheckpointSyncers};

/// Fetches signed checkpoints from multiple validators to create MultisigSignedCheckpoints
#[derive(Clone, Debug)]
pub struct MultisigCheckpointSyncer {
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<Address, CheckpointSyncers>,
}

impl MultisigCheckpointSyncer {
    /// Constructor
    pub fn new(checkpoint_syncers: HashMap<Address, CheckpointSyncers>) -> Self {
        MultisigCheckpointSyncer { checkpoint_syncers }
    }

    // TODO: Return an error if we can't find a checkpoint
    /// Attempts to get the latest checkpoint with a quorum of signatures among validators.
    ///
    /// First iterates through the `latest_index` of each validator's checkpoint syncer,
    /// looking for the highest index that >= `threshold` validators have returned.
    ///
    /// Attempts to find a quorum of signed checkpoints from that index, iterating
    /// backwards if unsuccessful, until the (optional) index is reached.
    ///
    /// Note it's possible to not find a quorum.
    #[instrument(err, skip(self))]
    pub async fn latest_checkpoint(
        &self,
        validators: Vec<H256>,
        threshold: usize,
        minimum_index: Option<u32>,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Get the latest_index from each validator's checkpoint syncer.
        let mut latest_indices = Vec::with_capacity(validators.len());
        for validator in validators.iter() {
            let addr: H160 = validator.clone().into();
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&addr) {
                // Gracefully handle errors getting the latest_index
                if let Ok(Some(index)) = checkpoint_syncer.latest_index().await {
                    latest_indices.push(index);
                }
            }
        }
        debug!(latest_indices=?latest_indices, "Fetched latest indices from checkpoint syncers");

        if latest_indices.is_empty() {
            return Ok(None);
        }

        // Sort in descending order. The n'th index will represent
        // the highest index for which we (supposedly) have (n+1) signed checkpoints
        latest_indices.sort_by(|a, b| b.cmp(a));
        if let Some(highest_quorum_index) = latest_indices.get(threshold - 1) {
            let mut i = *highest_quorum_index;
            while i > minimum_index.unwrap_or(0) {
                if let Ok(Some(checkpoint)) = self
                    .fetch_checkpoint(i, validators.clone(), threshold)
                    .await
                {
                    return Ok(Some(checkpoint));
                }
                i = i - 1;
            }
        }
        Ok(None)
    }

    /// Fetches a MultisigSignedCheckpoint if there is a quorum.
    /// Returns Ok(None) if there is no quorum.
    #[instrument(err, skip(self))]
    async fn fetch_checkpoint(
        &self,
        index: u32,
        validators: Vec<H256>,
        threshold: usize,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Keeps track of signed validator checkpoints for a particular root.
        // In practice, it's likely that validators will all sign the same root for a
        // particular index, but we'd like to be robust to this not being the case
        let mut signed_checkpoints_per_root: HashMap<H256, Vec<SignedCheckpointWithSigner>> =
            HashMap::new();

        for validator in validators.iter() {
            let addr: H160 = validator.clone().into();
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&addr) {
                // Gracefully ignore an error fetching the checkpoint from a validator's checkpoint syncer,
                // which can happen if the validator has not signed the checkpoint at `index`.
                if let Ok(Some(signed_checkpoint)) = checkpoint_syncer.fetch_checkpoint(index).await
                {
                    // If the signed checkpoint is for a different index, ignore it
                    if signed_checkpoint.checkpoint.index != index {
                        continue;
                    }
                    // Ensure that the signature is actually by the validator
                    let signer = signed_checkpoint.recover()?;
                    if H256::from(signer) != validator.clone() {
                        continue;
                    }

                    // Insert the SignedCheckpointWithSigner into signed_checkpoints_per_root
                    let signed_checkpoint_with_signer = SignedCheckpointWithSigner {
                        signer,
                        signed_checkpoint,
                    };
                    let root = signed_checkpoint_with_signer
                        .signed_checkpoint
                        .checkpoint
                        .root;

                    let signature_count = match signed_checkpoints_per_root.entry(root) {
                        Entry::Occupied(mut entry) => {
                            let vec = entry.get_mut();
                            vec.push(signed_checkpoint_with_signer);
                            vec.len()
                        }
                        Entry::Vacant(entry) => {
                            entry.insert(vec![signed_checkpoint_with_signer]);
                            1 // length of 1
                        }
                    };
                    // If we've hit a quorum, create a MultisigSignedCheckpoint
                    if signature_count >= threshold {
                        if let Some(signed_checkpoints) = signed_checkpoints_per_root.get(&root) {
                            let checkpoint =
                                MultisigSignedCheckpoint::try_from(signed_checkpoints)?;
                            debug!(checkpoint=?checkpoint, "Fetched multisig checkpoint");
                            return Ok(Some(checkpoint));
                        }
                    }
                }
            } else {
                warn!(
                    validator = format!("{:#x}", validator),
                    "Unable to find checkpoint syncer"
                );
                continue;
            }
        }
        Ok(None)
    }
}
