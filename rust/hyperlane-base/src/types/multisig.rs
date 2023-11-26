use std::collections::HashMap;
use std::sync::Arc;

use derive_new::new;
use eyre::Result;
use tracing::{debug, instrument};

use hyperlane_core::{MultisigSignedCheckpoint, SignedCheckpointWithMessageId, H160, H256};

use crate::{CheckpointSyncer, CoreMetrics};

/// Fetches signed checkpoints from multiple validators to create
/// MultisigSignedCheckpoints
#[derive(Clone, Debug, new)]
pub struct MultisigCheckpointSyncer {
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>>,
    metrics: Arc<CoreMetrics>,
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
        validators: &[H256],
        threshold: usize,
        minimum_index: u32,
        maximum_index: u32,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Get the latest_index from each validator's checkpoint syncer.
        let mut latest_indices = Vec::with_capacity(validators.len());
        for validator in validators {
            let address = H160::from(*validator);
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&address) {
                // Gracefully handle errors getting the latest_index
                match checkpoint_syncer.latest_index().await {
                    Ok(Some(index)) => {
                        debug!(?address, ?index, "Validator returned latest index");
                        latest_indices.push(index);
                    }
                    err => {
                        debug!(?address, ?err, "Failed to get latest index from validator");
                    }
                }
            }
        }
        debug!(
            ?latest_indices,
            "Fetched latest indices from checkpoint syncers"
        );

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
                debug!(%start_index, %highest_quorum_index, "Highest quorum index is below the minimum index");
                return Ok(None);
            }
            for index in (minimum_index..=start_index).rev() {
                if let Ok(Some(checkpoint)) =
                    self.fetch_checkpoint(validators, threshold, index).await
                {
                    return Ok(Some(checkpoint));
                }
            }
        }
        debug!("No checkpoint found in range");
        Ok(None)
    }

    /// Fetches a MultisigSignedCheckpointWithMessageId if there is a quorum.
    /// Validators must reflect the onchain ordering of the set
    /// Returns Ok(None) if there is no quorum.
    #[instrument(err, skip(self))]
    pub async fn fetch_checkpoint(
        &self,
        validators: &[H256],
        threshold: usize,
        index: u32,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Keeps track of signed validator checkpoints for a particular root.
        // In practice, it's likely that validators will all sign the same root for a
        // particular index, but we'd like to be robust to this not being the case
        let mut signed_checkpoints_per_root: HashMap<H256, Vec<SignedCheckpointWithMessageId>> =
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

                    // Push the signed checkpoint into the hashmap
                    let root = signed_checkpoint.value.root;
                    let signed_checkpoints = signed_checkpoints_per_root.entry(root).or_default();
                    signed_checkpoints.push(signed_checkpoint);

                    // Count the number of signatures for this signed checkpoint
                    let signature_count = signed_checkpoints.len();
                    debug!(
                        validator = format!("{:#x}", validator),
                        index = index,
                        root = format!("{:#x}", root),
                        signature_count = signature_count,
                        "Found signed checkpoint"
                    );

                    // If we've hit a quorum, create a MultisigSignedCheckpoint
                    if signature_count >= threshold {
                        let checkpoint: MultisigSignedCheckpoint = signed_checkpoints.try_into()?;
                        debug!(checkpoint=?checkpoint, "Fetched multisig checkpoint");
                        return Ok(Some(checkpoint));
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
        debug!("No quorum checkpoint found for message");
        Ok(None)
    }

    async fn fetch_latest_checkpoints(&self, validators: &[H256]) -> Result<Vec<u32>> {
        // Get the latest_index from each validator's checkpoint syncer.
        let mut latest_indices = Vec::with_capacity(validators.len());
        for validator in validators {
            let address = H160::from(*validator);
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&address) {
                // Gracefully handle errors getting the latest_index
                match checkpoint_syncer.latest_index().await {
                    Ok(Some(index)) => {
                        debug!(?address, ?index, "Validator returned latest index");
                        latest_indices.push(index);
                    }
                    err => {
                        debug!(?address, ?err, "Failed to get latest index from validator");
                    }
                }
            }
        }
        Ok(latest_indices)
    }
}
