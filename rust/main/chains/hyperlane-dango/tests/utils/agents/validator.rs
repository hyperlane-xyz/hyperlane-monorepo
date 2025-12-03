use {
    crate::utils::{AgentArgs, Args, Launcher, Location},
    grug::btree_map,
    hyperlane_core::H256,
    std::{
        collections::{BTreeMap, BTreeSet},
        path::PathBuf,
    },
};

#[derive(Default)]
pub struct Validator {
    origin_chain_name: Option<OriginChainName>,
    checkpoint_syncer: Option<CheckpointSyncer>,
    validator_signer: Option<ValidatorSigner>,
}

impl Validator {
    pub fn with_origin_chain_name<S: Into<String>>(mut self, origin_chain_name: S) -> Self {
        self.origin_chain_name = Some(OriginChainName(origin_chain_name.into()));
        self
    }

    pub fn with_checkpoint_syncer(mut self, checkpoint_syncer: CheckpointSyncer) -> Self {
        self.checkpoint_syncer = Some(checkpoint_syncer);
        self
    }

    pub fn with_validator_signer(mut self, validator_signer: ValidatorSigner) -> Self {
        self.validator_signer = Some(validator_signer);
        self
    }
}

impl Launcher for Validator {
    const PATH: &'static str = "validator";
}

impl AgentArgs for Validator {
    fn args(self, _chains: BTreeSet<String>) -> BTreeMap<String, String> {
        let mut args = BTreeMap::new();
        args.extend(self.origin_chain_name.args());
        args.extend(self.checkpoint_syncer.args());
        args.extend(self.validator_signer.args());
        args
    }
}

// ---- ARGS ----

pub struct S3CheckpointSyncer {
    bucket: String,
    region: String,
    folder: Option<String>,
}

pub enum CheckpointSyncer {
    LocalStorage(Location),
    S3(S3CheckpointSyncer),
}

impl CheckpointSyncer {
    pub fn temp() -> Self {
        Self::LocalStorage(Location::Temp)
    }

    pub fn persistent(path: PathBuf) -> Self {
        Self::LocalStorage(Location::Persistent(path))
    }

    pub fn s3(
        bucket: impl Into<String>,
        region: impl Into<String>,
        folder: Option<impl Into<String>>,
    ) -> Self {
        Self::S3(S3CheckpointSyncer {
            bucket: bucket.into(),
            region: region.into(),
            folder: folder.map(Into::into),
        })
    }
}

impl Args for CheckpointSyncer {
    fn args(self) -> BTreeMap<String, String> {
        match self {
            CheckpointSyncer::LocalStorage(location2) => btree_map! {
                "checkpointSyncer.type".to_string() => "localStorage".to_string(),
                "checkpointSyncer.path".to_string() => location2.get_path(),
            },
            CheckpointSyncer::S3(s3_checkpoint_syncer) => {
                let mut map = btree_map! {
                    "checkpointSyncer.type".to_string() => "s3".to_string(),
                    "checkpointSyncer.bucket".to_string() => s3_checkpoint_syncer.bucket,
                    "checkpointSyncer.region".to_string() => s3_checkpoint_syncer.region,
                };
                if let Some(folder) = s3_checkpoint_syncer.folder {
                    map.insert("checkpointSyncer.folder".to_string(), folder);
                }
                map
            }
        }
    }
}

pub struct OriginChainName(String);

impl Args for OriginChainName {
    fn args(self) -> BTreeMap<String, String> {
        btree_map! {
            "originChainName".to_string() => self.0,
        }
    }
}

pub enum ValidatorSigner {
    Hex(H256),
}

impl Args for ValidatorSigner {
    fn args(self) -> BTreeMap<String, String> {
        match self {
            ValidatorSigner::Hex(key) => btree_map! {
                "validator.type".to_string() => "hexKey".to_string(),
                "validator.key".to_string() => format!("{:?}", key),
            },
        }
    }
}
