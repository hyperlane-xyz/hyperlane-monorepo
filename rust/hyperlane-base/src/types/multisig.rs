use std::collections::{hash_map::Entry, HashMap};
use std::sync::Arc;

use derive_new::new;
use ethers::prelude::Address;
use eyre::Result;
use tracing::{debug, instrument, trace};

use hyperlane_core::{MultisigSignedCheckpoint, SignedCheckpointWithSigner, H160, H256};

use crate::CheckpointSyncer;

/// Fetches signed checkpoints from multiple validators to create
/// MultisigSignedCheckpoints
#[derive(Clone, Debug, new)]
pub struct MultisigCheckpointSyncer {
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<Address, Arc<dyn CheckpointSyncer>>,
}

impl MultisigCheckpointSyncer {
    /// Attempts to get the latest checkpoint with a quorum of signatures among
    /// validators.
    ///
    /// First iterates through the `latest_index` of each validator's checkpoint
    /// syncer, looking for the highest index that >= `threshold` validators
    /// have returned.
    ///
    /// Attempts to find a quorum of signed checkpoints from that index,
    /// iterating backwards if unsuccessful, until the (optional) index is
    /// reached.
    ///
    /// Note it's possible to not find a quorum.
    #[instrument(err, skip(self))]
    pub async fn fetch_checkpoint_in_range(
        &self,
        validators: &Vec<H256>,
        threshold: usize,
        minimum_index: u32,
        maximum_index: u32,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Get the latest_index from each validator's checkpoint syncer.
        let mut latest_indices = Vec::with_capacity(validators.len());
        for validator in validators.iter() {
            let address = H160::from(*validator);
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&address) {
                // Gracefully handle errors getting the latest_index
                match checkpoint_syncer.latest_index().await {
                    Ok(Some(index)) => {
                        trace!(?address, ?index, "Validator returned latest index");
                        latest_indices.push(index);
                    }
                    err => {
                        debug!(?address, ?err, "Failed to get last index from validator");
                    }
                }
            }
        }
        debug!(latest_indices=?latest_indices, "Fetched latest indices from checkpoint syncers");

        if latest_indices.is_empty() {
            debug!("No validators returned a latest index");
            return Ok(None);
        }

        // Sort in descending order. The n'th index will represent
        // the highest index for which we (supposedly) have (n+1) signed checkpoints
        latest_indices.sort_by(|a, b| b.cmp(a));
        if let Some(&highest_quorum_index) = latest_indices.get(threshold - 1) {
            // The highest viable checkpoint index is the minimum of the highest index
            // we (supposedly) have a quorum for, and the maximum index for which we can
            // generate a proof.
            let start_index = highest_quorum_index.min(maximum_index);
            if minimum_index > start_index {
                debug!(%start_index, %highest_quorum_index, "Highest validator index was below the last known quorum");
                return Ok(None);
            }
            for index in (minimum_index..=start_index).rev() {
                if let Ok(Some(checkpoint)) =
                    self.fetch_checkpoint(index, validators, threshold).await
                {
                    return Ok(Some(checkpoint));
                }
            }
        }
        debug!("No checkpoint found in range");
        Ok(None)
    }

    /// Fetches a MultisigSignedCheckpoint if there is a quorum.
    /// Returns Ok(None) if there is no quorum.
    #[instrument(err, skip(self))]
    async fn fetch_checkpoint(
        &self,
        index: u32,
        validators: &Vec<H256>,
        threshold: usize,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Keeps track of signed validator checkpoints for a particular root.
        // In practice, it's likely that validators will all sign the same root for a
        // particular index, but we'd like to be robust to this not being the case
        let mut signed_checkpoints_per_root: HashMap<H256, Vec<SignedCheckpointWithSigner>> =
            HashMap::new();

        for validator in validators.iter() {
            let addr = H160::from(*validator);
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&addr) {
                // Gracefully ignore an error fetching the checkpoint from a validator's
                // checkpoint syncer, which can happen if the validator has not
                // signed the checkpoint at `index`.
                if let Ok(Some(signed_checkpoint)) = checkpoint_syncer.fetch_checkpoint(index).await
                {
                    // If the signed checkpoint is for a different index, ignore it
                    if signed_checkpoint.value.index != index {
                        debug!(
                            validator = format!("{:#x}", validator),
                            index = index,
                            checkpoint_index = signed_checkpoint.value.index,
                            "Checkpoint index mismatch"
                        );
                        continue;
                    }
                    // Ensure that the signature is actually by the validator
                    let signer = signed_checkpoint.recover()?;
                    if H256::from(signer) != *validator {
                        debug!(
                            validator = format!("{:#x}", validator),
                            index = index,
                            "Checkpoint signature mismatch"
                        );
                        continue;
                    }

                    // Insert the SignedCheckpointWithSigner into signed_checkpoints_per_root
                    let signed_checkpoint_with_signer = SignedCheckpointWithSigner {
                        signer,
                        signed_checkpoint,
                    };
                    let root = signed_checkpoint_with_signer.signed_checkpoint.value.root;

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
                    debug!(
                        validator = format!("{:#x}", validator),
                        index = index,
                        root = format!("{:#x}", root),
                        signature_count = signature_count,
                        "Found signed checkpoint"
                    );
                    // If we've hit a quorum, create a MultisigSignedCheckpoint
                    if signature_count >= threshold {
                        if let Some(signed_checkpoints) = signed_checkpoints_per_root.get(&root) {
                            let checkpoint =
                                MultisigSignedCheckpoint::try_from(signed_checkpoints)?;
                            debug!(checkpoint=?checkpoint, "Fetched multisig checkpoint");
                            return Ok(Some(checkpoint));
                        }
                    }
                } else {
                    debug!(
                        validator = format!("{:#x}", validator),
                        index = index,
                        "Unable to find signed checkpoint"
                    );
                }
            } else {
                debug!(%validator, "Unable to find checkpoint syncer");
                continue;
            }
        }
        Ok(None)
    }
}
