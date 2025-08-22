use {
    crate::utils::{Agent, AgentBuilder, CheckpointSyncerLocation, DangoBuilder, ValidatorKey},
    dango_types::{constants::dango, gateway::TokenOrigin},
    grug::{
        btree_set, setup_tracing_subscriber, BlockCreation, Coin, Denom, Part, QueryClientExt,
        ResultExt,
    },
    std::time::Duration,
    tracing::{info, Level},
};

pub mod utils;

#[tokio::test]
async fn dango_integration() -> anyhow::Result<()> {
    setup_tracing_subscriber(Level::INFO);
    let mut ch1 = DangoBuilder::new("dango", 88888887)
        .with_block_creation(BlockCreation::OnBroadcast)
        .run()
        .await?;
    let mut ch2 = DangoBuilder::new("dango", 88888888)
        .with_block_creation(BlockCreation::OnBroadcast)
        .run()
        .await?;

    let chain_name1 = "dangotestnet1";
    let chain_name2 = "dangotestnet2";

    let validator_key = ValidatorKey::new_random();

    // run Validator
    {
        AgentBuilder::new(Agent::Validator)
            .with_origin_chain_name(chain_name1)
            .with_chain_helper(chain_name1, &ch1)
            .with_checkpoint_syncer(CheckpointSyncerLocation::LocalStorage)
            .with_validator_signer(validator_key.key.clone())
            .with_chain_signer(chain_name1, &ch1.accounts.user2)
            .launch();
    }

    // run Relayer
    {
        AgentBuilder::new(Agent::Relayer)
            .with_origin_chain_name(chain_name1)
            .with_chain_helper(chain_name1, &ch1)
            .with_chain_helper(chain_name2, &ch2)
            .with_relay_chains(btree_set!(chain_name1, chain_name2))
            .with_chain_signer(chain_name2, &ch2.accounts.user2)
            .with_allow_local_checkpoint_syncer(true)
            .with_metrics_port(9091)
            .launch();
    }

    ch1.set_route(
        TokenOrigin::Native(dango::DENOM.clone()),
        ch2.cfg.addresses.warp,
        ch2.hyperlane_domain,
    )
    .await?
    .outcome
    .should_succeed();

    ch2.set_validator_set(ch1.hyperlane_domain, 1, btree_set!(validator_key.address()))
        .await?
        .outcome
        .should_succeed();

    ch2.set_route(
        TokenOrigin::Remote(Part::new_unchecked("foo")),
        ch1.cfg.addresses.warp,
        ch1.hyperlane_domain,
    )
    .await?
    .outcome
    .should_succeed();

    ch1.send_remote(
        "user1",
        Coin::new(dango::DENOM.clone(), 100)?,
        ch2.hyperlane_domain,
        ch2.cfg.addresses.warp,
        ch2.accounts.user3.address.into_inner(),
    )
    .await?
    .outcome
    .should_succeed();

    loop {
        let balance = ch2
            .client
            .query_balance(
                ch2.accounts.user3.address.into_inner(),
                Denom::new_unchecked(["bridge", "foo"]),
                None,
            )
            .await?;

        info!("balance: {:?}", balance);

        if balance.0 == 100 {
            break;
        }

        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    Ok(())
}
