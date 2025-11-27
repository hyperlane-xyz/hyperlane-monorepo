use {
    crate::utils::{
        dango_helper::ChainHelper, get_free_port, Agent, CheckpointSyncer, DangoBuilder,
        DangoSettings, HexKey, Location2, Relayer, Validator, ValidatorSigner,
    },
    dango_types::gateway::Origin,
    futures_util::try_join,
    grug::{HexByteArray, ResultExt},
    std::collections::BTreeSet,
};

pub struct SetupChain {
    pub validators: u32,
    pub threshold: u32,
    pub route: Origin,
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

    let chain_name1 = "dangolocal1";
    let chain_name2 = "dangolocal2";

    let validators_1 = run_validators(&chain_1, &ch1, chain_name1)?;
    let validators_2 = run_validators(&chain_2, &ch2, chain_name2)?;

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

    Agent::new(Relayer::default().with_allow_local_checkpoint_syncer(true))
        .with_chain(
            DangoSettings::new(chain_name1)
                .with_chain_signer(ch1.get_account(&format!("user{}", chain_1.validators + 2)))
                .with_chain_settings(|dango| {
                    dango
                        .with_app_cfg(ch1.cfg.clone())
                        .with_chain_id(ch1.chain_id.clone())
                        .with_httpd_urls(ch1.httpd_urls.clone());
                }),
        )
        .with_chain(
            DangoSettings::new(chain_name2)
                .with_chain_signer(ch2.get_account(&format!("user{}", chain_2.validators + 2)))
                .with_chain_settings(|dango| {
                    dango
                        .with_app_cfg(ch2.cfg.clone())
                        .with_chain_id(ch2.chain_id.clone())
                        .with_httpd_urls(ch2.httpd_urls.clone());
                }),
        )
        .with_db(Location2::Temp)
        .with_metrics_port(get_free_port())
        .with_db(Location2::Temp)
        .launch();

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
            let key = HexKey::new_random();

            Agent::new(
                Validator::default()
                    .with_origin_chain_name(chain_name)
                    .with_checkpoint_syncer(CheckpointSyncer::LocalStorage(Location2::Temp))
                    .with_validator_signer(ValidatorSigner::Hex(key.key.clone())),
            )
            .with_chain(
                DangoSettings::new(chain_name)
                    .with_chain_signer(ch.get_account(&format!("user{}", i)))
                    .with_chain_settings(|dango| {
                        dango
                            .with_app_cfg(ch.cfg.clone())
                            .with_chain_id(ch.chain_id.clone())
                            .with_httpd_urls(ch.httpd_urls.clone());
                    }),
            )
            .with_metrics_port(get_free_port())
            .with_db(Location2::Temp)
            .launch();

            Ok(key.address())
        })
        .collect()
}

async fn register_onchain(
    route: Origin,
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
