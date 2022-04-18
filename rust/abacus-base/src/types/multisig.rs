use std::collections::{hash_map::Entry, HashMap};

use abacus_core::{MultisigSignedCheckpoint, SignedCheckpointWithSigner};
use ethers::prelude::Address;
use ethers::types::H256;

use color_eyre::Result;

use crate::{CheckpointSyncer, CheckpointSyncers};

/// Fetches signed checkpoints from multiple validators to create MultisigSignedCheckpoints
#[derive(Clone, Debug)]
pub struct MultisigCheckpointSyncer {
    /// The quorum threshold
    threshold: usize,
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<Address, CheckpointSyncers>,
}

impl MultisigCheckpointSyncer {
    /// Constructor
    pub fn new(threshold: usize, checkpoint_syncers: HashMap<Address, CheckpointSyncers>) -> Self {
        MultisigCheckpointSyncer {
            threshold,
            checkpoint_syncers,
        }
    }

    /// Fetches a MultisigSignedCheckpoint if there is a quorum.
    /// Returns Ok(None) if there is no quorum.
    pub async fn fetch_checkpoint(&self, index: u32) -> Result<Option<MultisigSignedCheckpoint>> {
        // Keeps track of signed validator checkpoints for a particular root.
        // In practice, it's likely that validators will all sign the same root for a
        // particular index, but we'd like to be robust to this not being the case
        let mut signed_checkpoints_per_root: HashMap<H256, Vec<SignedCheckpointWithSigner>> =
            HashMap::new();

        for (validator, checkpoint_syncer) in self.checkpoint_syncers.iter() {
            // Gracefully ignore an error fetching the checkpoint from a validator's checkpoint syncer,
            // which can happen if the validator has not signed the checkpoint at `index`.
            match checkpoint_syncer.fetch_checkpoint(index).await {
                Ok(Some(signed_checkpoint)) => {
                    // If the signed checkpoint is for a different index, ignore it
                    if signed_checkpoint.checkpoint.index != index {
                        continue;
                    }
                    // Ensure that the signature is actually by the validator
                    let signer = signed_checkpoint.recover()?;
                    if signer != *validator {
                        continue;
                    }

                    // Insert the SignedCheckpointWithSigner into signed_checkpoints_per_root
                    let signed_checkpoint_with_signer = SignedCheckpointWithSigner {
                        signer: signer,
                        signed_checkpoint: signed_checkpoint,
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
                    if signature_count >= self.threshold {
                        if let Some(signed_checkpoints) = signed_checkpoints_per_root.get(&root) {
                            return Ok(Some(MultisigSignedCheckpoint::try_from(
                                signed_checkpoints,
                            )?));
                        }
                    }
                }
                _ => {}
            }
        }

        return Ok(None);
    }

    /// Attempts to get the latest index with a quorum of signatures among validators.
    /// First iterates through the `latest_index` of each validator's checkpoint syncer,
    /// looking for the highest index that >= `threshold` validators have returned.
    /// If there isn't a quorum found this way, each unique index from the highest -> lowest
    /// is checked for a quorum of signed checkpoints using `fetch_checkpoint`.
    /// Note it's possible for both strategies for finding the latest index to not find a quorum.
    /// A more robust implementation should be considered in the future that indexes historical
    /// checkpoint indices.
    pub async fn latest_index(&self) -> Result<Option<u32>> {
        // Get the latest_index from each validator's checkpoint syncer.
        let mut latest_indices = Vec::with_capacity(self.checkpoint_syncers.len());
        for checkpoint_syncer in self.checkpoint_syncers.values() {
            // Gracefully handle errors getting the latest_index
            match checkpoint_syncer.latest_index().await {
                Ok(Some(index)) => {
                    latest_indices.push(index);
                }
                _ => {}
            }
        }
        if latest_indices.is_empty() {
            return Ok(None);
        }
        // Sort in descending order to iterate through higher indices first.
        latest_indices.sort_by(|a, b| b.cmp(a));

        let mut last_processed_index = 0;

        // Try to find a quorum among the latest indices
        let mut index_count = 0;
        for latest_index in &latest_indices {
            if *latest_index != last_processed_index {
                last_processed_index = *latest_index;
                index_count = 1;
            } else {
                index_count += 1;
            }

            // If we've found a quorum, return it
            if index_count >= self.threshold {
                return Ok(Some(last_processed_index));
            }
        }

        // If we didn't find a quorum simply among latest_index responses,
        // search for a quorum by trying to fetch checkpoints.

        // Ignore the highest index, which we know from the latest_index responses
        // to not have a quorum.
        last_processed_index = latest_indices[0];
        for latest_index in &latest_indices[1..] {
            // Don't try to fetch a checkpoint for the same index multiple times
            if *latest_index == last_processed_index {
                continue;
            }
            last_processed_index = *latest_index;

            if let Some(_) = self.fetch_checkpoint(last_processed_index).await? {
                return Ok(Some(last_processed_index));
            }
        }
        Ok(None)
    }
}
