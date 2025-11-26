use {
    crate::utils::{
        Agent, AgentBuilder, DangoBuilder, Location, SetupChain, ValidatorKey, build_agents, startup_tests, try_for
    },
    dango_types::{constants::dango, gateway::Origin},
    grug::{
        BlockCreation, Coin, Denom, Part, QueryClientExt, ResultExt, btree_set, setup_tracing_subscriber
    },
    std::time::Duration,
    tracing::Level,
};

pub mod utils;

#[tokio::test]
async fn dango_one_way() -> anyhow::Result<()> {
    setup_tracing_subscriber(Level::INFO);
    build_agents();
    let mut ch1 = DangoBuilder::new("dango", 88888887)
        .with_block_creation(BlockCreation::OnBroadcast)
        .run()
        .await?;
    let mut ch2 = DangoBuilder::new("dango", 88888888)
        .with_block_creation(BlockCreation::OnBroadcast)
        .run()
        .await?;

    let chain_name1 = "dangolocal1";
    let chain_name2 = "dangolocal2";

    let validator_key = ValidatorKey::new_random();

    // run Validator
    {
        AgentBuilder::new(Agent::Validator)
            .with_origin_chain_name(chain_name1)
            .with_chain_helper(chain_name1, &ch1)
            .with_checkpoint_syncer(Location::Temp)
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
        Origin::Local(dango::DENOM.clone()),
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
        Origin::Remote(Part::new_unchecked("foo")),
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

    try_for(
        Duration::from_secs(20),
        Duration::from_millis(100),
        || async {
            let balance = ch2
                .client
                .query_balance(
                    ch2.accounts.user3.address.into_inner(),
                    Denom::new_unchecked(["bridge", "foo"]),
                    None,
                )
                .await?;
            if balance.0 == 100 {
                Ok(())
            } else {
                Err(anyhow::anyhow!("Balance is not 100"))
            }
        },
    )
    .await?;

    Ok(())
}

#[tokio::test]
async fn dango_multiple_chains() -> anyhow::Result<()> {
    setup_tracing_subscriber(Level::INFO);
    build_agents();
    let (mut ch1, mut ch2) = startup_tests(
        SetupChain {
            validators: 3,
            threshold: 2,
            route: Origin::Local(dango::DENOM.clone()),
        },
        SetupChain {
            validators: 3,
            threshold: 2,
            route: Origin::Remote(Part::new_unchecked("foo")),
        },
    )
    .await?;

    let remote_denom = Denom::new_unchecked(["bridge", "foo"]);

    ch1.send_remote(
        "user1",
        Coin::new(dango::DENOM.clone(), 100)?,
        ch2.hyperlane_domain,
        ch2.cfg.addresses.warp,
        ch2.accounts.user1.address.into_inner(),
    )
    .await?
    .outcome
    .should_succeed();

    try_for(
        Duration::from_secs(20),
        Duration::from_millis(100),
        || async {
            let balance = ch2
                .client
                .query_balance(
                    ch2.accounts.user1.address.into_inner(),
                    remote_denom.clone(),
                    None,
                )
                .await?;

            if balance.0 == 100 {
                Ok(())
            } else {
                Err(anyhow::anyhow!("Balance is not 100"))
            }
        },
    )
    .await?;

    let current_balance = ch1
        .client
        .query_balance(
            ch1.accounts.user1.address.into_inner(),
            dango::DENOM.clone(),
            None,
        )
        .await?;

    // Send back
    ch2.send_remote(
        "user1",
        Coin::new(remote_denom, 100)?,
        ch1.hyperlane_domain,
        ch1.cfg.addresses.warp,
        ch1.accounts.user1.address.into_inner(),
    )
    .await?
    .outcome
    .should_succeed();

    try_for(
        Duration::from_secs(20),
        Duration::from_millis(100),
        || async {
            let balance = ch1
                .client
                .query_balance(
                    ch1.accounts.user1.address.into_inner(),
                    dango::DENOM.clone(),
                    None,
                )
                .await?;

            if balance.0 - current_balance.0 == 100 {
                Ok(())
            } else {
                Err(anyhow::anyhow!("Balance is not 100"))
            }
        },
    )
    .await?;

    Ok(())
}
