use std::collections::{HashMap, hash_map::Entry};

use abacus_core::{Checkpoint, SignedCheckpoint};
use ethers::prelude::{Address, Signature};
use ethers::types::H256;

use color_eyre::Result;

use crate::{CheckpointSyncer, CheckpointSyncers};

/// Fetches signed checkpoints from multiple validators to provide to multisig validator managers
pub struct MultisigCheckpointSyncer {
    /// The quorum threshold
    threshold: usize,
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<Address, CheckpointSyncers>,
}

#[derive(Debug, thiserror::Error)]
pub enum MultisigSignedCheckpointError {
    /// The signed checkpoint has no signatures
    #[error("Multisig signed checkpoint has no signatures")]
    EmptySignatures()
}

struct SignedCheckpointWithSigner {
    signer: Address,
    signed_checkpoint: SignedCheckpoint,
}

pub struct MultisigSignedCheckpoint {
    checkpoint: Checkpoint,
    signatures: Vec<Signature>
}

impl TryFrom<&mut Vec<SignedCheckpointWithSigner>> for MultisigSignedCheckpoint {
    type Error = MultisigSignedCheckpointError;

    /// Given multiple signed checkpoints with their signer, creates a MultisigSignedCheckpoint
    fn try_from(signed_checkpoints: &mut Vec<SignedCheckpointWithSigner>) -> Result<Self, Self::Error> {
        if signed_checkpoints.is_empty() {
            return Err(MultisigSignedCheckpointError::EmptySignatures())
        }
        // MultisigValidatorManagers expect signatures to be sorted by their signer in ascending
        // order to prevent duplicates
        signed_checkpoints.sort_by_key(|c| c.signer);
        let signatures = signed_checkpoints.iter().map(|c| c.signed_checkpoint.signature).collect();

        Ok(
            MultisigSignedCheckpoint {
                // Assume all signed_checkpoints are for the same checkpoint
                checkpoint: signed_checkpoints[0].signed_checkpoint.checkpoint,
                signatures,
            }
        )
    }
}

impl MultisigCheckpointSyncer {
    /// Constructor
    pub fn new(threshold: usize, checkpoint_syncers: HashMap<Address, CheckpointSyncers>) -> Self {
        MultisigSyncer {
            threshold,
            checkpoint_syncers
        }
    }

    /// Fetches a checkpoint if there is a quorum.
    /// Returns Ok(None) if there is no quorum.
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<MultisigSignedCheckpoint>> {
        let validator_count = self.checkpoint_syncers.len();

        // Keeps track of signed validator checkpoints for a particular root.
        // In practice, it's likely that validators will all sign the same root for a
        // particular index, but we'd like to be robust to this not being the case
        let mut signed_checkpoints_per_root: HashMap<H256, Vec<SignedCheckpointWithSigner>> = HashMap::new();

        for validator in self.checkpoint_syncers.values() {
            // Gracefully ignore an error fetching the checkpoint from a validator's checkpoint syncer,
            // which can happen if the validator has not signed the checkpoint at `index`.
            match validator.checkpoint_syncer.fetch_checkpoint(index).await {
                Ok(opt_signed_checkpoint) => {
                    if let Some(signed_checkpoint) = opt_signed_checkpoint {
                        // If the signed checkpoint is for a different index, ignore it
                        if signed_checkpoint.checkpoint.index != index {
                            continue;
                        }
                        // Ensure that the signature is actually by a validator
                        let signer = signed_checkpoint.recover()?;
                        if !self.checkpoint_syncers.contains_key(&signer) {
                            continue;
                        }
                        
                        // Insert the SignedCheckpointWithSigner into signed_checkpoints_per_root
                        let signed_checkpoint_with_signer = SignedCheckpointWithSigner {
                            signer: signer,
                            signed_checkpoint: signed_checkpoint,
                        };
                        let root = signed_checkpoint_with_signer.signed_checkpoint.checkpoint.root;
        
                        let signature_count = match signed_checkpoints_per_root.entry(root) {
                            Entry::Occupied(mut entry) => {
                                let vec = entry.get_mut();
                                vec.push(signed_checkpoint_with_signer);
                                vec.len()
                            },
                            Entry::Vacant(entry) => {
                                entry.insert(vec![signed_checkpoint_with_signer]);
                                1 // length of 1
                            },
                        };
                        // If we've hit a quorum, create a MultisigSignedCheckpoint
                        if signature_count >= self.threshold {
                            if let Some(signed_checkpoints) = signed_checkpoints_per_root.get_mut(&root) {
                                return Ok(
                                    Some(
                                        MultisigSignedCheckpoint::try_from(signed_checkpoints)?
                                    )
                                );
                            }
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
    /// If there isn't a quorum found this way, each 
    async fn latest_index(&self) -> Result<Option<u32>> {
        // Get the latest_index from each validator's checkpoint syncer.
        let mut latest_indices = Vec::with_capacity(self.checkpoint_syncers.len());
        for validator in self.checkpoint_syncers.values() {
            match validator.checkpoint_syncer.latest_index().await? {
                Some(index) => {
                    latest_indices.push(index);
                },
                _ => {},
            }
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

        last_processed_index = 0;
        for latest_index in &latest_indices {
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
