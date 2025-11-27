use {
    crate::utils::{
        build_agents, workspace, Agent, CheckpointSyncer, DangoSettings, EvmSettings, Location2,
        LogLevel, Relayer, Validator,
    },
    dango_hyperlane_testing::constants::MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS,
    dango_testing::constants::{user4, user6},
    dango_types::config::AppConfig,
    grug::{addr, HexByteArray, QueryClientExt},
    grug_indexer_client::HttpClient,
    hyperlane_base::settings::SignerConf,
    hyperlane_core::H256,
    std::str::FromStr,
};

pub mod utils;

#[tokio::test]
async fn run_relayer() -> anyhow::Result<()> {
    dotenvy::from_filename(workspace().join("chains/hyperlane-dango/tests/.env"))?;

    let sepolia_key = H256::from_str(&dotenvy::var("SEPOLIA_RELAYER_KEY")?)?;

    println!("sepolia_key: {}", sepolia_key);

    build_agents();

    let dango_client = HttpClient::new("https://api-pr-1414-ovh2.dango.zone")?;
    let app_cfg: AppConfig = dango_client.query_app_config(None).await?;

    Agent::new(Relayer::default().with_allow_local_checkpoint_syncer(true))
        .with_chain(
            EvmSettings::new("sepolia")
                .with_index(9718682, Some(20))
                .with_chain_signer(SignerConf::HexKey { key: sepolia_key }),
        )
        .with_chain(
            DangoSettings::new("dangolocal2")
                .with_chain_signer(SignerConf::Dango {
                    username: user4::USERNAME.clone(),
                    key: HexByteArray::from_inner(user4::PRIVATE_KEY),
                    address: addr!("5a7213b5a8f12e826e88d67c083be371a442689c"),
                })
                .with_index(967610, Some(500))
                .with_chain_settings(|dango| {
                    dango.with_app_cfg(app_cfg);
                    dango.with_chain_id("pr-1414".to_string());
                    dango.with_httpd_urls(["https://api-pr-1414-ovh2.dango.zone"]);
                }),
        )
        .with_metrics_port(9090)
        .with_db(Location2::Persistent(workspace().join("relayer")))
        .with_log_level(LogLevel::Error)
        .launch();

    loop {}
}

#[tokio::test]
async fn run_dango_validator() -> anyhow::Result<()> {
    build_agents();

    let dango_client = HttpClient::new("https://api-pr-1414-ovh2.dango.zone")?;
    let app_cfg = dango_client.query_app_config(None).await?;
    let path = workspace().join("val-1");

    Agent::new(
        Validator::default()
            .with_origin_chain_name("dangolocal2")
            .with_checkpoint_syncer(CheckpointSyncer::LocalStorage(Location2::Persistent(
                path.clone(),
            )))
            .with_validator_signer(utils::ValidatorSigner::Hex(H256::from(
                MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS[0],
            ))),
    )
    .with_chain(
        DangoSettings::new("dangolocal2")
            .with_chain_signer(SignerConf::Dango {
                username: user6::USERNAME.clone(),
                key: HexByteArray::from_inner(user6::PRIVATE_KEY),
                address: addr!("365a389d8571b681d087ee8f7eecf1ff710f59c8"),
            })
            .with_index(967610, Some(20))
            .with_chain_settings(|dango| {
                dango
                    .with_app_cfg(app_cfg)
                    .with_chain_id("pr-1414".to_string())
                    .with_httpd_urls(["https://api-pr-1414-ovh2.dango.zone"]);
            }),
    )
    .with_metrics_port(9091)
    .with_db(Location2::Persistent(path))
    .with_log_level(LogLevel::Warn)
    .launch();

    loop {}
}
