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
mod invariants;
mod node;
mod ops;
mod types;

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

    sleep(Duration::from_secs(10));

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

    let loop_start = Instant::now();
    let mut failure_occurred = false;
    loop {
        // look for the end condition.
        if termination_invariants_met(
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
        panic!("E2E tests failed");
    } else {
        log!("E2E tests passed");
    }
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

#[cfg(feature = "cosmosnative")]
#[cfg(test)]
mod test {
    #[tokio::test]
    async fn test_run() {
        use crate::sovereign::run_locally;

        run_locally().await;
    }
}
