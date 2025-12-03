use {
    crate::utils::{
        build_agents, workspace, Agent, CheckpointSyncer, DangoSettings, EvmSettings, Location,
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

const HTTPD_URL: &str = "http://127.0.0.1:8080";

fn load_env() {
    if let Err(e) = dotenvy::from_filename(workspace().join("chains/hyperlane-dango/tests/.env")) {
        println!("Error loading .env file: {}", e);
    }
}

#[tokio::test]
#[ignore]
async fn run_relayer() -> anyhow::Result<()> {
    load_env();

    let sepolia_key = H256::from_str(&dotenvy::var("SEPOLIA_RELAYER_KEY")?)?;

    build_agents();

    let dango_client = HttpClient::new(HTTPD_URL)?;
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
                .with_index(1, Some(20))
                .with_chain_settings(|dango| {
                    dango.with_app_cfg(app_cfg);
                    dango.with_chain_id("pr-1414".to_string());
                    dango.with_httpd_urls([HTTPD_URL]);
                }),
        )
        .with_metrics_port(9090)
        .with_db(Location::Persistent(workspace().join("relayer")))
        .with_log_level(LogLevel::Error)
        .launch();

    loop {}
}

#[tokio::test]
#[ignore]
async fn run_dango_validator() -> anyhow::Result<()> {
    load_env();

    build_agents();

    let dango_client = HttpClient::new(HTTPD_URL)?;
    let chain_id = dango_client.query_status(None).await?.chain_id;
    let app_cfg = dango_client.query_app_config(None).await?;
    let path = workspace().join("val-1");

    Agent::new(
        Validator::default()
            .with_origin_chain_name("dangolocal2")
            .with_checkpoint_syncer(CheckpointSyncer::s3(
                "hyperlane-test",
                "eu-north-1",
                None::<String>,
            ))
            // .with_checkpoint_syncer(CheckpointSyncer::LocalStorage(Location::Temp))
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
            .with_index(1, Some(20))
            .with_chain_settings(|dango| {
                dango
                    .with_app_cfg(app_cfg)
                    .with_chain_id(chain_id)
                    .with_httpd_urls([HTTPD_URL]);
            }),
    )
    .with_metrics_port(9091)
    .with_db(Location::Persistent(path))
    .with_log_level(LogLevel::Info)
    .launch();

    loop {}
}
