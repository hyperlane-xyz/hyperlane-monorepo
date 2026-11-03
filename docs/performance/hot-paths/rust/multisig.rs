#![allow(dead_code)]

use std::{collections::HashMap, sync::Arc, time::Instant};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{
    Checkpoint, CheckpointWithMessageId, HyperlaneDomain, HyperlaneSignerExt, KnownHyperlaneDomain,
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId, H160, H256,
};
use hyperlane_ethereum::Signers;

use crate::{tests::test_validators::dummy_validators, CheckpointSyncer};

mod before {
    include!(concat!(env!("HOTPATH_SOURCE_DIR"), "/multisig_before.rs"));
}

mod support {
    include!(concat!(env!("HOTPATH_HARNESS_DIR"), "/support.rs"));
}

use support::{Activity, Version};

#[derive(Debug)]
struct Rpc {
    activity: Arc<Activity>,
    milliseconds: u64,
    checkpoint: Option<SignedCheckpointWithMessageId>,
}

#[async_trait]
impl CheckpointSyncer for Rpc {
    async fn fetch_checkpoint(&self, _: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let _active = self.activity.enter();
        support::delay(self.milliseconds).await;
        Ok(self.checkpoint.clone())
    }

    async fn latest_index(&self) -> Result<Option<u32>> {
        unreachable!("not used by benchmark")
    }
    async fn write_latest_index(&self, _: u32) -> Result<()> {
        unreachable!("not used by benchmark")
    }
    async fn write_checkpoint(&self, _: &SignedCheckpointWithMessageId) -> Result<()> {
        unreachable!("not used by benchmark")
    }
    async fn write_metadata(&self, _: &str) -> Result<()> {
        unreachable!("not used by benchmark")
    }
    async fn write_announcement(&self, _: &SignedAnnouncement) -> Result<()> {
        unreachable!("not used by benchmark")
    }
    fn announcement_location(&self) -> String {
        "synthetic-benchmark".to_owned()
    }
    async fn write_reorg_status(&self, _: &ReorgEvent) -> Result<()> {
        unreachable!("not used by benchmark")
    }
    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        unreachable!("not used by benchmark")
    }
}

#[tokio::test]
#[ignore = "controlled performance experiment; run through docs/performance/hot-paths/rust/run.py"]
async fn measure_hot_paths() {
    let checkpoint = CheckpointWithMessageId {
        checkpoint: Checkpoint {
            mailbox_domain: 100,
            merkle_tree_hook_address: H256::zero(),
            root: H256::zero(),
            index: 1000,
        },
        message_id: H256::zero(),
    };
    // Signing and fixture construction are outside every timed interval.
    let mut fixtures = Vec::new();
    for validator in dummy_validators() {
        let signer: Signers = validator
            .private_key
            .parse::<ethers::signers::LocalWallet>()
            .expect("existing test fixture signer")
            .into();
        fixtures.push((
            validator
                .public_key
                .parse::<H160>()
                .expect("validator address"),
            signer.sign(checkpoint).await.expect("signed checkpoint"),
        ));
    }
    assert_eq!(fixtures.len(), 7);
    let validators: Vec<_> = fixtures
        .iter()
        .map(|(address, _)| H256::from(*address))
        .collect();
    let destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let warmups = support::parameter("HOTPATH_WARMUP", 5);
    let repetitions = support::parameter("HOTPATH_REPETITIONS", 30);
    for scenario in ["zero", "uniform", "straggler"] {
        for iteration in 0..warmups.saturating_add(repetitions) {
            for version in support::order(iteration) {
                let activity = Arc::new(Activity::default());
                let mut syncers: HashMap<H160, Arc<dyn CheckpointSyncer>> = HashMap::new();
                for (index, (address, signed)) in fixtures.iter().enumerate() {
                    let milliseconds = match scenario {
                        "zero" => 0,
                        "straggler" if index == 0 => 45,
                        _ => 5,
                    };
                    let has_signature = scenario != "straggler" || [1, 4, 5].contains(&index);
                    syncers.insert(
                        *address,
                        Arc::new(Rpc {
                            activity: activity.clone(),
                            milliseconds,
                            checkpoint: has_signature.then(|| signed.clone()),
                        }),
                    );
                }
                let (elapsed, result) = match version {
                    Version::Before => {
                        let syncer = before::MultisigCheckpointSyncer::new(syncers, None);
                        let start = Instant::now();
                        let result = syncer
                            .fetch_checkpoint(&validators, 3, 1000, &destination)
                            .await;
                        (start.elapsed(), result)
                    }
                    Version::After => {
                        let syncer = super::MultisigCheckpointSyncer::new(syncers, None);
                        let start = Instant::now();
                        let result = syncer
                            .fetch_checkpoint(&validators, 3, 1000, &destination)
                            .await;
                        (start.elapsed(), result)
                    }
                };
                let result = result.expect("quorum lookup").expect("quorum checkpoint");
                assert_eq!(result.checkpoint, checkpoint);
                assert_eq!(result.signatures.len(), 3);
                assert!(activity.peak.load(std::sync::atomic::Ordering::Relaxed) <= 4);
                support::record(
                    "multisig_quorum",
                    scenario,
                    version,
                    iteration,
                    iteration < warmups,
                    elapsed,
                    1,
                    &activity,
                );
            }
        }
    }
}
