use {
    crate::utils::{AgentArgs, Args, Launcher},
    grug::btree_map,
    std::collections::{BTreeMap, BTreeSet},
};

#[derive(Default)]
pub struct Relayer {
    allow_local_checkpoint_syncer: Option<AllowLocalCheckpointSyncer>,
}

impl Relayer {
    pub fn with_allow_local_checkpoint_syncer(
        mut self,
        allow_local_checkpoint_syncer: bool,
    ) -> Self {
        self.allow_local_checkpoint_syncer =
            Some(AllowLocalCheckpointSyncer(allow_local_checkpoint_syncer));
        self
    }
}

impl Launcher for Relayer {
    const PATH: &'static str = "relayer";
}

impl AgentArgs for Relayer {
    fn args(self, chains: BTreeSet<String>) -> BTreeMap<String, String> {
        let mut args = BTreeMap::new();
        let chains = chains.into_iter().collect::<Vec<_>>().join(",");
        args.extend(self.allow_local_checkpoint_syncer.args());
        args.extend(btree_map! {
            "relayChains".to_string() => chains,
        });
        args
    }
}

// ---- ARGS ----

pub struct AllowLocalCheckpointSyncer(bool);

impl Args for AllowLocalCheckpointSyncer {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "allowLocalCheckpointSyncers".to_string() => self.0.to_string(),
        }
    }
}
