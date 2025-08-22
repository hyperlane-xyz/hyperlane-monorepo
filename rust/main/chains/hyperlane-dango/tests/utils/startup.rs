use {
    crate::utils::{
        dango_helper::ChainHelper, get_free_port, Agent, AgentBuilder, CheckpointSyncerLocation,
        DangoBuilder, ValidatorKey,
    },
    dango_types::gateway::TokenOrigin,
    futures_util::try_join,
    grug::{btree_set, HexByteArray, ResultExt},
    std::collections::BTreeSet,
};

pub struct SetupChain {
    pub validators: u32,
    pub threshold: u32,
    pub route: TokenOrigin,
}

pub async fn startup_tests(
    chain_1: SetupChain,
    chain_2: SetupChain,
) -> anyhow::Result<(ChainHelper, ChainHelper)> {
    let (mut ch1, mut ch2) = try_join!(
        DangoBuilder::new("dango-88888887", 88888887)
            .with_block_creation(grug::BlockCreation::OnBroadcast)
            .run(),
        DangoBuilder::new("dango-88888888", 88888888)
            .with_block_creation(grug::BlockCreation::OnBroadcast)
            .run()
    )?;

    let chain_name1 = "dangotestnet1";
    let chain_name2 = "dangotestnet2";

    let validators_1 = run_validators(&chain_1, &ch1, chain_name1)?;
    let validators_2 = run_validators(&chain_2, &ch2, chain_name2)?;

    AgentBuilder::new(Agent::Relayer)
        .with_chain_helper(chain_name1, &ch1)
        .with_chain_helper(chain_name2, &ch2)
        .with_relay_chains(btree_set!(chain_name1, chain_name2))
        .with_chain_signer(
            chain_name1,
            ch1.get_account(&format!("user{}", chain_1.validators + 2)),
        )
        .with_chain_signer(
            chain_name2,
            ch2.get_account(&format!("user{}", chain_2.validators + 2)),
        )
        .with_allow_local_checkpoint_syncer(true)
        .with_metrics_port(get_free_port())
        .launch();

    register_onchain(
        chain_1.route,
        &mut ch1,
        &ch2,
        validators_2,
        chain_2.threshold,
    )
    .await?;

    register_onchain(
        chain_2.route,
        &mut ch2,
        &ch1,
        validators_1,
        chain_1.threshold,
    )
    .await?;

    Ok((ch1, ch2))
}

fn run_validators(
    setup: &SetupChain,
    ch: &ChainHelper,
    chain_name: &str,
) -> anyhow::Result<BTreeSet<HexByteArray<20>>> {
    (2..=setup.validators + 1)
        .into_iter()
        .map(|i| {
            let key = ValidatorKey::new_random();

            AgentBuilder::new(Agent::Validator)
                .with_origin_chain_name(chain_name)
                .with_chain_helper(chain_name, ch)
                .with_checkpoint_syncer(CheckpointSyncerLocation::LocalStorage)
                .with_validator_signer(key.key.clone())
                .with_chain_signer(chain_name, ch.get_account(&format!("user{}", i)))
                .with_metrics_port(get_free_port())
                .launch();

            Ok(key.address())
        })
        .collect()
}

async fn register_onchain(
    route: TokenOrigin,
    local: &mut ChainHelper,
    remote: &ChainHelper,
    remote_validators_addresses: BTreeSet<HexByteArray<20>>,
    remote_threshold: u32,
) -> anyhow::Result<()> {
    local
        .set_route(route, remote.cfg.addresses.warp, remote.hyperlane_domain)
        .await?
        .outcome
        .should_succeed();

    local
        .set_validator_set(
            remote.hyperlane_domain,
            remote_threshold,
            remote_validators_addresses,
        )
        .await?
        .outcome
        .should_succeed();

    Ok(())
}
