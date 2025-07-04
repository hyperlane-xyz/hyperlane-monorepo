use std::collections::HashMap;
use std::sync::Arc;

use derive_new::new;
use eyre::Result;
use futures::StreamExt;
use tracing::{debug, instrument, warn};

use hyperlane_core::{
    HyperlaneDomain, MultisigSignedCheckpoint, SignedCheckpointWithMessageId, H160, H256,
};

use crate::{CheckpointSyncer, CoreMetrics};

/// For a particular validator set, fetches signed checkpoints from multiple
/// validators to create MultisigSignedCheckpoints.
#[derive(Clone, Debug, new)]
pub struct MultisigCheckpointSyncer {
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>>,
    metrics: Option<(Arc<CoreMetrics>, String)>, // first arg is the metrics, second is the app context
}

impl MultisigCheckpointSyncer {
    /// Gets the latest checkpoint index from each validator's checkpoint syncer.
    /// Returns a vector of the latest indices, in an unspecified order, and does
    /// not contain indices for validators that did not provide a latest index.
    /// Also updates the validator latest checkpoint metrics.
    pub async fn get_validator_latest_checkpoints_and_update_metrics(
        &self,
        validators: &[H256],
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Vec<(H160, u32)> {
        // Get the latest_index from each validator's checkpoint syncer.
        // If a validator does not return a latest index, None is recorded so
        // this can be surfaced in the metrics.
        let mut latest_indices: HashMap<H160, Option<u32>> =
            HashMap::with_capacity(validators.len());

        let syncer = validators
            .iter()
            .map(|v| H160::from(*v))
            .filter_map(|v| {
                if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&v) {
                    Some((v, checkpoint_syncer))
                } else {
                    warn!(validator=%v, "Checkpoint syncer is not provided for validator");
                    None
                }
            })
            .collect::<Vec<_>>();
        let futures = syncer
            .iter()
            .map(
                |(v, checkpoint_syncer)| async move { (v, checkpoint_syncer.latest_index().await) },
            )
            .collect::<Vec<_>>();

        let validator_index_results = futures::stream::iter(futures)
            .buffer_unordered(10)
            .collect::<Vec<_>>()
            .await;

        for (validator, latest_index) in validator_index_results {
            match latest_index {
                Ok(Some(index)) => {
                    debug!(?validator, ?index, "Validator returned latest index");
                    latest_indices.insert(*validator, Some(index));
                }
                result => {
                    debug!(
                        ?validator,
                        ?result,
                        "Failed to get latest index from validator"
                    );
                    latest_indices.insert(*validator, None);
                }
            }
        }

        if let Some((metrics, app_context)) = &self.metrics {
            metrics
                .validator_metrics
                .set_validator_latest_checkpoints(
                    origin,
                    destination,
                    app_context.clone(),
                    &latest_indices,
                )
                .await;
        }

        // Filter out any validators that did not return a latest index
        latest_indices
            .into_iter()
            .filter_map(|(address, index)| index.map(|i| (address, i)))
            .collect()
    }

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
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        let mut latest_indices = self
            .get_validator_latest_checkpoints_and_update_metrics(validators, origin, destination)
            .await;

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
        latest_indices.sort_by(|a, b| b.1.cmp(&a.1));

        if let Some(&(_, highest_quorum_index)) = latest_indices.get(threshold - 1) {
            // The highest viable checkpoint index is the minimum of the highest index
            // we (supposedly) have a quorum for, and the maximum index for which we can
            // generate a proof.
            let start_index = highest_quorum_index.min(maximum_index);
            if minimum_index > start_index {
                debug!(%start_index, %highest_quorum_index, "Highest quorum index is below the minimum index");
                return Ok(None);
            }

            for index in (minimum_index..=start_index).rev() {
                let checkpoint_res = self.fetch_checkpoint(validators, threshold, index).await;
                if let Ok(Some(checkpoint)) = checkpoint_res {
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

        // we iterate in batches of N=threshold*1.5 to avoid waiting for all validators.
        // This reaches a quorum faster without having to fetch all the signatures.

        // Also limit this number in case we have a large threshold
        let batch_size = (threshold as f64 * 1.5) as usize;
        let batch_size = batch_size.clamp(1, 10);

        for validators in validators.chunks(batch_size) {
            // Go through each validator and get the checkpoint syncer.
            // Create a future for each validator that fetches its signed checkpoint
            let futures = validators
                .iter()
                .filter_map(|address| {
                    if let Some(syncer) = self.checkpoint_syncers.get(&H160::from(*address)) {
                        Some((address, syncer))
                    } else {
                        debug!(validator=%address, "Checkpoint syncer not found");
                        None
                    }
                })
                .map(|(address, syncer)| {
                    let checkpoint_syncer = syncer.clone();
                    async move { (address, checkpoint_syncer.fetch_checkpoint(index).await) }
                })
                .collect::<Vec<_>>();

            let checkpoints = futures::future::join_all(futures).await;

            for (validator, checkpoint) in checkpoints {
                // Gracefully ignore an error fetching the checkpoint from a validator's
                // checkpoint syncer, which can happen if the validator has not
                // signed the checkpoint at `index`.
                if let Ok(Some(signed_checkpoint)) = checkpoint {
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
            }
        }
        debug!("No quorum checkpoint found for message");
        Ok(None)
    }
}

#[cfg(test)]
pub mod test {
    use std::str::FromStr;

    use aws_config::Region;
    use hyperlane_core::{
        Checkpoint, CheckpointWithMessageId, HyperlaneSignerExt, KnownHyperlaneDomain,
    };
    use hyperlane_ethereum::Signers;

    use crate::{
        tests::{dummy_validators, mock_checkpoint_syncer::MockCheckpointSyncer, TestValidator},
        S3Storage,
    };

    use super::*;

    async fn build_mock_checkpoint_syncs(
        validators: &[TestValidator],
    ) -> HashMap<H160, Arc<dyn CheckpointSyncer + 'static>> {
        let mut syncers: HashMap<_, _> = HashMap::new();
        for validator in validators {
            let signer: Signers = validator
                .private_key
                .parse::<ethers::signers::LocalWallet>()
                .unwrap()
                .into();
            let syncer = MockCheckpointSyncer::new();
            syncer
                .responses
                .latest_index
                .lock()
                .unwrap()
                .push_back(Ok(validator.latest_index.clone()));
            let sig = match validator.fetch_checkpoint {
                Some(checkpoint) => Ok(Some(signer.sign(checkpoint).await.unwrap())),
                None => Ok(None),
            };
            syncer
                .responses
                .fetch_checkpoint
                .lock()
                .unwrap()
                .push_back(sig);
            let key = H160::from_str(&validator.public_key).unwrap();
            let val = Arc::new(syncer) as Arc<dyn CheckpointSyncer>;
            syncers.insert(key, val);
        }
        syncers
    }

    async fn generate_multisig_signed_checkpoint(
        validators: &[TestValidator],
        checkpoint: CheckpointWithMessageId,
    ) -> MultisigSignedCheckpoint {
        let mut signatures = Vec::new();
        for validator in validators.iter().filter(|v| v.fetch_checkpoint.is_some()) {
            let signer: Signers = validator
                .private_key
                .parse::<ethers::signers::LocalWallet>()
                .unwrap()
                .into();
            let sig = signer.sign(checkpoint.clone()).await.unwrap();
            signatures.push(sig.signature);
        }

        MultisigSignedCheckpoint {
            checkpoint,
            signatures,
        }
    }

    #[tokio::test]
    #[ignore]
    #[tracing_test::traced_test]
    async fn test_s3_checkpoint_syncer() {
        let validators = vec![
            (
                "0x4d966438fe9E2B1e7124c87bBB90cB4F0F6C59a1",
                (
                    "hyperlane-mainnet3-arbitrum-validator-0".to_string(),
                    Region::new("us-east-1"),
                ),
            ),
            (
                "0x5450447aeE7B544c462C9352bEF7cAD049B0C2Dc",
                (
                    "zpl-hyperlane-v3-arbitrum".to_string(),
                    Region::new("eu-central-1"),
                ),
            ),
            (
                "0xec68258A7c882AC2Fc46b81Ce80380054fFB4eF2",
                (
                    "dsrv-hyperlane-v3-validator-signatures-validator7-arbitrum".to_string(),
                    Region::new("eu-central-1"),
                ),
            ),
            (
                "0x38C7A4ca1273ead2E867d096aDBCDD0e2AcB21D8",
                (
                    "hyperlane-v3-validator-signatures-everstake-one-arbitrum".to_string(),
                    Region::new("us-east-2"),
                ),
            ),
            (
                "0xb3AC35d3988bCA8C2fFD195b1c6bee18536B317b",
                (
                    "can-outrun-imperial-starships-v3-arbitrum".to_string(),
                    Region::new("eu-west-1"),
                ),
            ),
            (
                "0x14d0B24d3a8F3aAD17DB4b62cBcEC12821c98Cb3",
                (
                    "hyperlane-validator-signatures-bwarelabs-ethereum/arbitrum".to_string(),
                    Region::new("eu-north-1"),
                ),
            ),
            (
                "0xc4b877Dd49ABe9B38EA9184683f9664c0F9FADe3",
                (
                    "arbitrum-validator-signatures/arbitrum".to_string(),
                    Region::new("us-east-1"),
                ),
            ),
        ];

        let syncers = validators
            .iter()
            .map(|(address, (bucket, region))| {
                let syncer = S3Storage::new(bucket.clone(), None, region.clone(), None);
                (
                    H160::from_str(address).unwrap(),
                    Arc::new(syncer) as Arc<dyn CheckpointSyncer>,
                )
            })
            .collect::<HashMap<_, _>>();

        // Create a multisig checkpoint syncer
        let multisig_syncer = MultisigCheckpointSyncer::new(syncers, None);

        let validators = validators
            .iter()
            .map(|(address, _)| {
                let address: H256 = H160::from_str(address).unwrap().into();
                address
            })
            .collect::<Vec<_>>();

        // get the latest checkpoint from each validator
        let mut latest_indices = multisig_syncer
            .get_validator_latest_checkpoints_and_update_metrics(
                validators.as_slice(),
                &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            )
            .await;
        latest_indices.sort_by(|a, b| b.cmp(a));

        let lowest_index = *latest_indices.last().unwrap();

        let start_time = std::time::Instant::now();

        for threshold in 2..=6 {
            println!("Starting to fetch checkpoints with threshold {}", threshold);
            if let Some(&(_, highest_quorum_index)) = latest_indices.get(threshold - 1) {
                let result = multisig_syncer
                    .fetch_checkpoint_in_range(
                        validators.as_slice(),
                        threshold,
                        lowest_index.1,
                        highest_quorum_index,
                        &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                        &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                    )
                    .await;
                assert!(result.is_ok(), "Failed to fetch checkpoint");
            }
        }

        let elapsed = start_time.elapsed();
        println!("Fetched checkpoints in {}ms", elapsed.as_millis());
    }

    #[tokio::test]
    async fn test_get_validator_latest_checkpoints_and_update_metrics() {
        let mut validators = dummy_validators();
        validators[0].latest_index = Some(200);
        validators[1].latest_index = Some(300);
        validators[3].latest_index = Some(500);
        validators[5].latest_index = Some(700);
        validators[6].latest_index = Some(800);

        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let validator_addresses = validators
            .iter()
            .map(|validator| {
                let address: H256 = H160::from_str(&validator.public_key).unwrap().into();
                address
            })
            .collect::<Vec<_>>();

        // Create a multisig checkpoint syncer
        let multisig_syncer = MultisigCheckpointSyncer::new(syncers, None);

        // get the latest checkpoint from each validator
        let latest_indices: HashMap<_, _> = multisig_syncer
            .get_validator_latest_checkpoints_and_update_metrics(
                validator_addresses.as_slice(),
                &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            )
            .await
            .into_iter()
            .collect();

        for validator in validators {
            let validator_address = H160::from_str(&validator.public_key).unwrap();
            let validator_latest_index = latest_indices.get(&validator_address).cloned();
            assert_eq!(validator_latest_index, validator.latest_index);
        }
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_fetch_checkpoint_in_range_correct_order() {
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 100,
                merkle_tree_hook_address: H256::zero(),
                root: H256::zero(),
                index: 1000,
            },
            message_id: H256::zero(),
        };

        let mut validators: Vec<_> = dummy_validators().drain(..).take(5).collect();
        validators[0].latest_index = Some(1010);
        validators[0].fetch_checkpoint = Some(checkpoint.clone());
        validators[1].latest_index = Some(1008);
        validators[2].latest_index = Some(1006);
        validators[3].latest_index = Some(1004);
        validators[3].fetch_checkpoint = Some(checkpoint.clone());
        validators[4].latest_index = Some(1002);
        validators[4].fetch_checkpoint = Some(checkpoint.clone());

        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let validator_addresses = validators
            .iter()
            .map(|validator| {
                let address: H256 = H160::from_str(&validator.public_key).unwrap().into();
                address
            })
            .collect::<Vec<_>>();

        // Create a multisig checkpoint syncer
        let multisig_syncer = MultisigCheckpointSyncer::new(syncers, None);

        let threshold = 3;
        let minimum_index = 990;
        let maximum_index = 1000;
        let result = multisig_syncer
            .fetch_checkpoint_in_range(
                validator_addresses.as_slice(),
                threshold,
                minimum_index,
                maximum_index,
                &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
                &HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum),
            )
            .await
            .unwrap();

        let expected = Some(generate_multisig_signed_checkpoint(&validators, checkpoint).await);
        assert_eq!(result, expected);
    }

    #[tracing_test::traced_test]
    #[tokio::test]
    async fn test_fetch_checkpoint_correct_order() {
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 100,
                merkle_tree_hook_address: H256::zero(),
                root: H256::zero(),
                index: 1000,
            },
            message_id: H256::zero(),
        };

        let mut validators: Vec<_> = dummy_validators().drain(..).take(5).collect();
        validators[0].latest_index = Some(1010);
        validators[0].fetch_checkpoint = Some(checkpoint.clone());
        validators[1].latest_index = Some(1008);
        validators[2].latest_index = Some(1006);
        validators[3].latest_index = Some(1004);
        validators[3].fetch_checkpoint = Some(checkpoint.clone());
        validators[4].latest_index = Some(1002);
        validators[4].fetch_checkpoint = Some(checkpoint.clone());

        let syncers = build_mock_checkpoint_syncs(&validators).await;
        let validator_addresses = validators
            .iter()
            .map(|validator| {
                let address: H256 = H160::from_str(&validator.public_key).unwrap().into();
                address
            })
            .collect::<Vec<_>>();

        // Create a multisig checkpoint syncer
        let multisig_syncer = MultisigCheckpointSyncer::new(syncers, None);

        let threshold = 3;
        let index = 1000;
        let result = multisig_syncer
            .fetch_checkpoint(validator_addresses.as_slice(), threshold, index)
            .await
            .unwrap();

        let expected = Some(generate_multisig_signed_checkpoint(&validators, checkpoint).await);
        assert_eq!(result, expected);
    }
}
