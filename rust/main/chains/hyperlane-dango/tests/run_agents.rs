use {
    crate::utils::{build_agents, Agent, AgentBuilder, Location},
    dango_hyperlane_testing::constants::MOCK_HYPERLANE_VALIDATOR_SIGNING_KEYS,
    dango_testing::constants::user4,
    grug::{btree_set, Addr, HexByteArray},
    hyperlane_base::settings::SignerConf,
    hyperlane_core::H256,
    std::str::FromStr,
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
                address: Addr::from_str("0x5a7213b5a8f12e826e88d67c083be371a442689c")?,
            },
        )
        .with_allow_local_checkpoint_syncer(true)
        .with_metrics_port(9093)
        .launch();

    loop {}
}
