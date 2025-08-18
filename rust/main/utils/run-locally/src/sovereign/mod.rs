#![allow(dead_code)]

use std::{
    fs,
    path::Path,
    sync::atomic::Ordering,
    thread::sleep,
    time::{Duration, Instant},
};

use agents::{start_relayer, start_scraper, start_scraper_db, start_validators, VALIDATOR_ADDRESS};
use maplit::hashmap;
use ops::{connect_chains, dispatch_transfers, ChainRouter};
use serde_json::json;
use tempfile::tempdir;
use types::{get_or_create_client, ChainConfig, ChainRegistry};

use crate::sovereign::agents::RELAYER_METRICS_PORT;
use crate::sovereign::node::SovereignParameters;
use crate::sovereign::ops::set_relayer_igp_configs;
use crate::{
    config::Config,
    fetch_metric,
    invariants::post_startup_invariants,
    logging::log,
    long_running_processes_exited_check,
    metrics::agent_balance_sum,
    program::Program,
    utils::{concat_path, get_workspace_path, make_static},
    wait_for_condition, AgentHandles, State, TaskHandle, AGENT_BIN_PATH, AGENT_LOGGING_DIR,
    SCRAPER_METRICS_PORT, SHUTDOWN,
};

mod agents;
mod node;
mod ops;
mod types;

pub const SOVEREIGN_MESSAGES_EXPECTED: u32 = 10;

/// Test private keys for Sovereign chains
// https://github.com/Sovereign-Labs/rollup-starter/blob/main/test-data/keys/token_deployer_private_key.json
const RELAYER_KEY: &str = "0x0187c12ea7c12024b3f70ac5d73587463af17c8bce2bd9e6fe87389310196c64";
// rollup-starter uses ethereum style accounts
const RELAYER_ADDRESS: &str = "0xA6edfca3AA985Dd3CC728BFFB700933a986aC085";

#[allow(dead_code)]
async fn run_locally() {
    // Signal handler for graceful shutdown
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    log!("Running simplified Sovereign node startup test...");

    let mut state = State::default();

    // Setup and start Sovereign rollup nodes
    log!("Setting up Sovereign rollup environment...");
    let (_rollup_dir, agent_and_confs) = node::setup_sovereign_environment();
    let (agents, params): (Vec<AgentHandles>, Vec<SovereignParameters>) =
        agent_and_confs.into_iter().unzip();

    for agent in agents {
        state.push_agent(agent);
    }

    log!("{:?}", &params);
    log!("Waiting for Sovereign nodes to be ready...");

    wait_until_nodes_healthy(&params);

    let chain_registry = ChainRegistry {
        chains: params
            .iter()
            .map(|p| (p.chain_name(), ChainConfig::new(RELAYER_KEY, p)))
            .collect(),
    };

    log!("{:?}", &chain_registry);
    set_relayer_igp_configs(&chain_registry, RELAYER_ADDRESS).await;
    let routers = connect_chains(&chain_registry, RELAYER_ADDRESS, VALIDATOR_ADDRESS).await;

    let data_dir = tempdir().unwrap();
    let agent_conf_path = concat_path(&data_dir, "config.json");
    fs::write(
        &agent_conf_path,
        serde_json::to_string_pretty(&chain_registry)
            .expect("Failed to serialize chain registry config"),
    )
    .expect("Failed to write chain registry to file");
    log!("wrote config to: {}", &agent_conf_path.display());

    // log!("initializing scrapper agent");
    // let postgres = start_scraper_db();
    // state.push_agent(postgres);
    //
    // log!("starting scrapper");
    // let scrapper = start_scraper(&agent_conf_path, &chain_registry);
    // state.push_agent(scrapper);

    log!("starting relayer");
    let relayer = start_relayer(&agent_conf_path, &chain_registry, data_dir.path());
    state.push_agent(relayer);

    log!("starting validators");
    let validators = start_validators(&agent_conf_path, &chain_registry, data_dir.path());

    for validator in validators {
        state.push_agent(validator);
    }
    // give things a chance to fully start.
    sleep(Duration::from_secs(20));

    log!("Setup complete! Agents running in background...");
    log!("Ctrl+C to end execution...");

    let starting_relayer_balance: f64 = agent_balance_sum(RELAYER_METRICS_PORT.into()).unwrap();
    log!("relayer starting balance: {}", starting_relayer_balance);

    let amount = dispatch_transfers(&chain_registry, &routers, 5, RELAYER_ADDRESS).await;
    log!("dispatched {} messages", amount);
    sleep(Duration::from_secs(80));

    let delivered_messages_count = fetch_metric(
        &RELAYER_METRICS_PORT.to_string(),
        "hyperlane_operations_processed_count",
        &hashmap! {"phase" => "confirmed"},
    )
    .unwrap()
    .iter()
    .sum::<u32>();

    log!("delivered messages count {}", delivered_messages_count);
    let ending_balance: f64 = agent_balance_sum(RELAYER_METRICS_PORT.into()).unwrap();
    log!(
        "relayer starting balance: {}, ending balance: {}",
        starting_relayer_balance,
        ending_balance
    );

    todo!();

    let loop_start = Instant::now();

    // perform transfers back and forth
    // validate transfers

    /* COMMENTED OUT FOR SIMPLE NODE TEST - UNCOMMENT LATER FOR FULL E2E TESTS

    let common_agent_env = create_common_agent();

    //
    // Ready to run...
    //

    // Build rust agents
    log!("Building rust...");
    let build_main = Program::new("cargo")
        .cmd("build")
        .working_dir(&workspace_path)
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run();

    // TODO: Add more message dispatch after relayer comes up

    // TODO: Implement sovereign-specific termination invariants
    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            // TODO: Add sovereign termination invariants
            Ok(true)
        },
        || !SHUTDOWN.load(Ordering::Relaxed),
        || long_running_processes_exited_check(&mut state),
    );

    if !test_passed {
        panic!("Failure occurred during Sovereign E2E");
    }
    log!("Sovereign E2E tests passed");
    */
}

fn wait_until_nodes_healthy(params: &[SovereignParameters]) {
    let timeout_duration = Duration::from_secs(30); // 30 second timeout
    let check_interval = Duration::from_secs(2); // Check every 2 seconds
    let start_time = Instant::now();

    loop {
        let mut all_healthy = true;

        for param in params {
            let health_url = format!("http://127.0.0.1:{}", param.port);
            if !node::check_sovereign_node_health(&health_url) {
                all_healthy = false;
                break;
            }
        }

        if all_healthy {
            log!("All {} Sovereign nodes are healthy and ready", params.len());
            return;
        }

        let elapsed = start_time.elapsed();
        if elapsed >= timeout_duration {
            panic!(
                "Nodes did not become healthy within {:?}!",
                timeout_duration
            );
        }

        let remaining_time = timeout_duration - elapsed;
        log!(
            "Waiting for nodes to become healthy... (remaining time: {:.1}s)",
            remaining_time.as_secs_f64()
        );

        sleep(check_interval);
    }
}

fn termination_invariants_met(
    relayer_metrics_port: u32,
    _scraper_metrics_port: u32,
    messages_expected: u32,
    starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    let delivered_messages_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_operations_processed_count",
        &hashmap! {"phase" => "confirmed"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_count != messages_expected {
        log!(
            "Relayer confirmed {} submitted messages, expected {}",
            delivered_messages_count,
            messages_expected
        );
        return Ok(false);
    }

    // we can check the events endpoint for message deliver/dispatched events instead of scraper

    let ending_relayer_balance: f64 = agent_balance_sum(relayer_metrics_port).unwrap();

    // Make sure the balance was correctly updated in the metrics.
    if starting_relayer_balance <= ending_relayer_balance {
        log!(
            "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
            starting_relayer_balance,
            ending_relayer_balance
        );
        return Ok(false);
    }

    log!("Termination invariants have been met");
    Ok(true)
}

#[cfg(test)]
mod test {
    #[tokio::test]
    async fn test_run() {
        use crate::sovereign::run_locally;

        run_locally().await;
    }
}
