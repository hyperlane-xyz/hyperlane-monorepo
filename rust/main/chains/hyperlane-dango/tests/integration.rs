use {
    crate::utils::{Agent, AgentBuilder, DangoBuilder, ValidatorKey},
    grug::ResultExt,
    hyperlane_base::settings::CheckpointSyncerConf,
};

pub mod utils;

#[tokio::test]
async fn dango_integration() -> anyhow::Result<()> {
    let mut ch1 = DangoBuilder::new("dango", 88888887).run().await?;
    let mut ch2 = DangoBuilder::new("dango", 88888888).run().await?;

    let location = "checkpoint_dango1";
    let validator_key = ValidatorKey::new_random();

    AgentBuilder::new(Agent::Validator)
        .with_origin_chain_name("dangotestnet1")
        .with_chain_helper("dangotestnet1", &ch1)
        .with_checkpoint_syncer(CheckpointSyncerConf::LocalStorage {
            path: location.into(),
        })
        .with_validator_signer(validator_key.key.clone())
        .with_chain_signer("dangotestnet1", &ch1.accounts.user2)
        .launch();

    ch1.set_route("dango", ch2.cfg.addresses.warp, ch2.hyperlane_domain)
        .await?
        .outcome
        .should_succeed();

    loop {}
}

//  cargo test --package hyperlane-dango --test integration -- dango_integration --exact --nocapture

//  cargo test -- dango_integration --exact --nocapture
