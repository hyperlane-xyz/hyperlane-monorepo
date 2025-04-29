use deploy::deploy_fuel_hyperlane;
use ethers::types::H160;
use fuels::{
    accounts::{signers::private_key::PrivateKeySigner, wallet::Wallet},
    crypto::SecretKey,
    prelude::{FuelService, Provider},
    programs::calls::{CallParameters, Execution},
    test_helpers::{ChainConfig, NodeConfig, StateConfig},
    types::{transaction_builders::VariableOutputPolicy, AssetId, Bits256, Bytes, ContractId},
};
use futures::future::join_all;
use macro_rules_attribute::apply;
use std::{
    collections::BTreeMap,
    fs,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    str::FromStr,
    thread::sleep,
    time::{Duration, Instant},
};

use tempfile::tempdir;

use crate::{
    invariants::base_termination_invariants_met,
    log,
    metrics::agent_balance_sum,
    program::Program,
    types::{AgentConfig, AgentConfigOut, HyperlaneStack},
    utils::{as_task, concat_path, AgentHandles, TaskHandle},
    AGENT_BIN_PATH,
};

mod abis;
mod deploy;
mod types;

pub use types::*;

// From fuel_core_chain_config::config::state
pub const FUEL_WALLET_PKS: [&str; 5] = [
    "0xde97d8624a438121b86a1956544bd72ed68cd69f2c99555b08b1e8c51ffd511c", // Deployer - Node 1
    "0x37fa81c84ccd547c30c176b118d5cb892bdb113e8e80141f266519422ef9eefd", // Deployer - Node 2
    "0x862512a2363db2b3a375c0d4bbbd27172180d89f23f2e259bac850ab02619301", // Validator - Node 1
    "0x976e5c3fa620092c718d852ca703b6da9e3075b9f2ecb8ed42d9f746bf26aafb", // Validator - Node 2
    "0x7f8a325504e7315eda997db7861c9447f5c3eff26333b20180475d94443a10c6",
];

pub const EVM_VALIDATOR_PKS: [&str; 2] = [
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // Signer for Validator 1
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // Signer for Validator 2
];

pub async fn launch_fuel_node(port: u16) -> eyre::Result<FuelService> {
    let node_config = NodeConfig {
        addr: SocketAddr::new(Ipv4Addr::new(127, 0, 0, 1).into(), port),
        ..Default::default()
    };
    Ok(FuelService::start(
        node_config,
        ChainConfig::local_testnet(),
        StateConfig::local_testnet(),
    )
    .await?)
}

#[apply(as_task)]
fn launch_fuel_validator(
    agent_config: AgentConfig,
    agent_config_path: PathBuf,
    validator_key: String,
    debug: bool,
) -> AgentHandles {
    let validator_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let validator_base = tempdir().expect("Failed to create a temp dir").into_path();
    let validator_base_db = concat_path(&validator_base, "db");
    println!("Validator Base: {:?}", validator_base);

    fs::create_dir_all(&validator_base_db).unwrap();
    println!("Validator DB: {:?}", validator_base_db);

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");
    Program::default()
        .bin(validator_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path.to_str().unwrap())
        .env(
            "MY_VALIDATOR_SIGNATURE_DIRECTORY",
            signature_path.to_str().unwrap(),
        )
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap())
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("ORIGINCHAINNAME", agent_config.name)
        .hyp_env("DB", validator_base_db.to_str().unwrap())
        .hyp_env("METRICSPORT", agent_config.metrics_port.to_string())
        .hyp_env("VALIDATOR_KEY", validator_key) // EVM private key
        .hyp_env(
            "VALIDATOR_PREFIX",
            format!("fueltest-{}", agent_config.domain_id),
        )
        .hyp_env("SIGNER_SIGNER_TYPE", "hexKey")
        .hyp_env("SIGNER_KEY", agent_config.signer.key) // FUEL private key
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .spawn("VAL", None)
}

#[apply(as_task)]
fn launch_fuel_relayer(
    agent_config_path: String,
    relay_chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().unwrap();

    Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("DB", relayer_base.as_ref().to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("GASPAYMENTENFORCEMENT", "[{\"type\": \"none\"}]")
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("RLY", None)
}

#[apply(as_task)]
fn launch_fuel_scraper(
    agent_config_path: String,
    chains: Vec<String>,
    metrics: u32,
    debug: bool,
) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper");

    Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", chains.join(","))
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("TRACING_LEVEL", if debug { "debug" } else { "info" })
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("SCR", None)
}

#[allow(dead_code)]
async fn run_locally() -> eyre::Result<()> {
    const TIMEOUT_SECS: u64 = 60 * 10;
    let debug = false;

    // log!("Building rust...");
    Program::new("cargo")
        .cmd("build")
        .working_dir("../../")
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run()
        .join();

    let port_start = 42069u16;
    let metrics_port_start = 9090u32;
    let domain_start = 13373u32;
    let node_count = 2;

    log!("Starting Fuel nodes...");
    let nodes_futures = (0..node_count)
        .map(|i| async move {
            FuelConfig {
                node: launch_fuel_node(port_start + i as u16).await.unwrap(),
                metrics_port: metrics_port_start + i,
                domain: domain_start + i,
            }
        })
        .collect::<Vec<_>>();
    let nodes = join_all(nodes_futures).await;

    log!("Depolying Hyperlane...");
    let nodes = nodes.into_iter().enumerate().map(|(i, config)| async move {
        let provider = Provider::from(config.node.bound_address()).await.unwrap();
        assert!(provider.healthy().await.unwrap());

        let wallet = Wallet::new(
            PrivateKeySigner::new(SecretKey::from_str(FUEL_WALLET_PKS[i]).unwrap()),
            provider,
        );
        let (target_domain, name, validator_addr) = match config.domain {
            13373 => (
                13374,
                "fueltest1".to_owned(),
                H160::from_str("0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc").unwrap(),
            ),
            13374 => (
                13373,
                "fueltest2".to_owned(),
                H160::from_str("0x15d34aaf54267db7d7c367839aaf71a00a2c6a65").unwrap(),
            ),
            _ => unreachable!(),
        };
        FuelNetwork {
            name,
            deployments: deploy_fuel_hyperlane(
                wallet,
                config.domain,
                target_domain,
                validator_addr,
            )
            .await,
            config,
        }
    });
    let nodes = join_all(nodes).await;

    // count all the dispatched messages
    let mut dispatched_messages = 0;

    // dispatch the first batch of messages (before agents start)
    dispatched_messages += dispatch(&nodes).await;

    let config_dir = tempdir().unwrap();
    let agent_config_out = AgentConfigOut {
        chains: nodes
            .iter()
            .enumerate()
            .map(|(i, v)| {
                (
                    v.name.clone(),
                    // Local Fuel networks named 1 and 2
                    AgentConfig::fuel((i + 1) as u32, FUEL_WALLET_PKS[i], v),
                )
            })
            .collect::<BTreeMap<String, AgentConfig>>(),
    };

    let agent_config_path = concat_path(&config_dir, "config.json");
    fs::write(
        &agent_config_path,
        serde_json::to_string_pretty(&agent_config_out).unwrap(),
    )
    .unwrap();

    log!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);

    sleep(Duration::from_secs(15));

    log!("Init postgres db...");
    Program::new(concat_path(format!("../../{AGENT_BIN_PATH}"), "init-db"))
        .run()
        .join();

    let hpl_val = agent_config_out
        .chains
        .clone()
        .into_values()
        .enumerate()
        .map(|(i, agent_config)| {
            launch_fuel_validator(
                agent_config,
                agent_config_path.clone(),
                EVM_VALIDATOR_PKS[i].to_owned(),
                debug,
            )
        })
        .collect::<Vec<_>>();

    let chains = agent_config_out.chains.into_keys().collect::<Vec<_>>();
    let path = agent_config_path.to_str().unwrap();

    let hpl_rly_metrics_port = metrics_port_start + node_count + 1u32;
    let hpl_rly = launch_fuel_relayer(path.to_owned(), chains.clone(), hpl_rly_metrics_port, debug);

    let hpl_scr_metrics_port = hpl_rly_metrics_port + 1u32;
    let hpl_scr = launch_fuel_scraper(path.to_owned(), chains.clone(), hpl_scr_metrics_port, debug);

    // give things a chance to fully start.
    sleep(Duration::from_secs(10));

    let starting_relayer_balance: f64 = agent_balance_sum(hpl_rly_metrics_port).unwrap();

    // dispatch the second batch of messages (after agents start)
    dispatched_messages += dispatch(&nodes).await;

    let _stack = HyperlaneStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
        scraper: hpl_scr.join(),
        postgres,
    };

    let loop_start = Instant::now();
    let mut failure_occurred = false;
    loop {
        // look for the end condition.
        if base_termination_invariants_met(
            hpl_rly_metrics_port,
            hpl_scr_metrics_port,
            dispatched_messages,
            starting_relayer_balance,
        )
        .unwrap_or(false)
        {
            // end condition reached successfully
            break;
        } else if (Instant::now() - loop_start).as_secs() > TIMEOUT_SECS {
            // we ran out of time
            log!("timeout reached before message submission was confirmed");
            failure_occurred = true;
            break;
        }

        sleep(Duration::from_secs(5));
    }

    if failure_occurred {
        stop_fuel_nodes(nodes).await;
        panic!("E2E tests failed");
    } else {
        log!("E2E tests passed");
    }

    // Stop nodes
    stop_fuel_nodes(nodes).await;

    Ok(())
}

async fn stop_fuel_nodes(nodes: Vec<FuelNetwork>) {
    log!("Stopping Fuel nodes...");

    join_all(nodes.into_iter().map(|network| async move {
        let state = network.config.node.stop().await.unwrap();
        assert!(state.stopped());
    }))
    .await;
}

pub async fn dispatch(nodes: &[FuelNetwork]) -> u32 {
    let mut dispatched_messages = 0;
    for node in nodes.iter() {
        let targets = nodes
            .iter()
            .filter(|v| v.config.domain != node.config.domain)
            .collect::<Vec<_>>();

        for target in targets {
            let msg_body = Bytes("Hello, world!".as_bytes().to_vec());
            let recipient = Bits256(
                ContractId::from(target.deployments.msg_recipient_test.contract_id()).into(),
            );

            let quote = node
                .deployments
                .mailbox
                .methods()
                .quote_dispatch(
                    target.config.domain,
                    recipient,
                    msg_body.clone(),
                    Bytes(vec![]),
                    ContractId::default(),
                )
                .determine_missing_contracts()
                .await
                .unwrap()
                .simulate(Execution::realistic())
                .await
                .unwrap();

            let res = node
                .deployments
                .mailbox
                .methods()
                .dispatch(
                    target.config.domain,
                    recipient,
                    msg_body.clone(),
                    Bytes(vec![]),
                    ContractId::default(),
                )
                .call_params(CallParameters::new(quote.value, AssetId::BASE, 1_500_000))
                .unwrap()
                .with_variable_output_policy(VariableOutputPolicy::EstimateMinimum)
                .determine_missing_contracts()
                .await
                .unwrap()
                .call()
                .await;
            assert!(res.is_ok());

            let provider = Provider::from(node.config.node.bound_address())
                .await
                .unwrap();
            let block = provider
                .get_transaction_by_id(&res.unwrap().tx_id.unwrap())
                .await
                .unwrap()
                .unwrap()
                .block_height
                .unwrap();

            log!(
                "Dispatched message from {} to {} - at block {}",
                node.config.domain,
                target.config.domain,
                *block
            );
            dispatched_messages += 1;
        }
    }

    log!("Dispatched {} messages", dispatched_messages);

    dispatched_messages
}

#[cfg(feature = "fuel")]
mod test {

    #[test]
    fn test_run() {
        use crate::fuel::run_locally;

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_locally())
            .unwrap();
    }
}
