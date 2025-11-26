use {
    crate::utils::{
        build_agents, Agent, AgentBuilder, DangoChainSettings, EvmChainSettings, Launcher,
        Location, RelayerAgent,
    },
    dango_hyperlane_testing::constants::MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS,
    dango_testing::constants::user4,
    grug::{addr, btree_set, HexByteArray, QueryClientExt},
    grug_indexer_client::HttpClient,
    hyperlane_base::settings::SignerConf,
    hyperlane_core::H256,
};

pub mod utils;

#[tokio::test]
#[ignore]
async fn run_validators() -> anyhow::Result<()> {
    build_agents();

    AgentBuilder::new(Agent::Validator)
        .with_origin_chain_name("sepolia")
        .with_validator_signer(H256::from(MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS[0]))
        .with_checkpoint_syncer(Location::persistent("./valsepolia1"))
        .with_metrics_port(9091)
        .launch();
    AgentBuilder::new(Agent::Validator)
        .with_origin_chain_name("sepolia")
        .with_validator_signer(H256::from(MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS[1]))
        .with_checkpoint_syncer(Location::persistent("./valsepolia2"))
        .with_metrics_port(9092)
        .launch();

    loop {}
}

#[tokio::test]
#[ignore]
async fn run_relayers() -> anyhow::Result<()> {
    build_agents();

    AgentBuilder::new(Agent::Relayer)
        .with_relay_chains(btree_set!("sepolia", "dangolocal2"))
        .with_chain_signer(
            "sepolia",
            SignerConf::HexKey {
                key: H256::from(MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS[2]),
            },
        )
        .with_chain_signer(
            "dangolocal2",
            SignerConf::Dango {
                username: user4::USERNAME.clone(),
                key: HexByteArray::from_inner(user4::PRIVATE_KEY),
                address: addr!("5a7213b5a8f12e826e88d67c083be371a442689c"),
            },
        )
        .with_allow_local_checkpoint_syncer(true)
        .with_metrics_port(9093)
        .launch();

    loop {}
}

#[tokio::test]
async fn run_relayer2() -> anyhow::Result<()> {
    build_agents();

    let dango_client = HttpClient::new("https://api-pr-1414-ovh2.dango.zone")?;
    let app_cfg = dango_client.query_app_config(None).await?;

    RelayerAgent::default()
        .with_chain(EvmChainSettings::new("sepolia").with_index(9712111, Some(20)))
        .with_chain(
            DangoChainSettings::new("dangolocal2")
                .with_chain_signer(SignerConf::Dango {
                    username: user4::USERNAME.clone(),
                    key: HexByteArray::from_inner(user4::PRIVATE_KEY),
                    address: addr!("5a7213b5a8f12e826e88d67c083be371a442689c"),
                })
                .with_index(739345, Some(200))
                .with_chain_settings(|dango| {
                    dango.with_app_cfg(app_cfg);
                    dango.with_chain_id("pr-1414".to_string());
                    dango.with_httpd_urls(["https://api-pr-1414-ovh2.dango.zone"]);
                }),
        )
        .launch();

    loop {}
}
