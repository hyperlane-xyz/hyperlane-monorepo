use std::path::{Path, PathBuf};

use grug::setup_tracing_subscriber;
use hyperlane_base::{agent_main, settings::CheckpointSyncerConf};
use tracing::Level;
use url::Url;

use crate::utils::{Agent, AgentBuilder, DangoBuilder, ValidatorKey};

mod utils;

#[tokio::test]
async fn dango_integration() {
    // setup_tracing_subscriber(Level::INFO);

    let dango = DangoBuilder::new("dango", 88888887).run().await.unwrap();
    let _dango_2 = DangoBuilder::new("dango-2", 2).run().await.unwrap();
    let location = "checkpoint_dango1";
    let validator_key = ValidatorKey::new_random();

    AgentBuilder::new(Agent::Validator)
        .with_origin_chain_name("dangotestnet1")
        .with_chain_helper("dangotestnet1", &dango)
        .with_checkpoint_syncer(CheckpointSyncerConf::LocalStorage {
            path: location.into(),
        })
        .with_validator_signer(validator_key.key.clone())
        .with_chain_signer("dangotestnet1", &dango.accounts.user2)
        .launch();

    loop {}
}

//  cargo test --package hyperlane-dango --test integration -- dango_integration --exact --nocapture

//  cargo test -- dango_integration --exact --nocapture

