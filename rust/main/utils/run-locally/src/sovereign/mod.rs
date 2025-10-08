use std::{
    fs,
    sync::atomic::Ordering,
    thread::sleep,
    time::{Duration, Instant},
};

use agents::{start_relayer, start_scraper, start_scraper_db, start_validators, VALIDATOR_ADDRESS};
use ops::{connect_chains, dispatch_transfers};
use tempfile::tempdir;
use types::{ChainConfig, ChainRegistry};

use crate::sovereign::invariants::termination_invariants_met;
use crate::sovereign::node::SovereignParameters;
use crate::sovereign::ops::set_relayer_igp_configs;
use crate::{
    config::Config, logging::log, metrics::agent_balance_sum, program::Program, utils::concat_path,
    wait_for_condition, AgentHandles, State, TaskHandle, SHUTDOWN,
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
pub const RELAYER_ADDRESS: &str = "0xA6edfca3AA985Dd3CC728BFFB700933a986aC085";

async fn run_locally() {
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    log!("Building rust...");
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

    log!("Running simplified Sovereign node startup test...");

    let mut state = State::default();

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
    let agent_conf_path = concat_path(data_dir.path(), "config.json");
    fs::write(
        &agent_conf_path,
        serde_json::to_string_pretty(&chain_registry)
            .expect("Failed to serialize chain registry config"),
    )
    .expect("Failed to write chain registry to file");
    log!("wrote config to: {}", &agent_conf_path.display());

    log!("initializing scrapper db");
    let postgres = start_scraper_db();
    state.push_agent(postgres);

    log!("starting scrapper");
    let scrapper = start_scraper(&agent_conf_path, &chain_registry);
    state.push_agent(scrapper);

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

    let relayer_metrics_port: u32 = crate::RELAYER_METRICS_PORT
        .parse()
        .expect("Failed to parse relayer metrics port");
    let starting_relayer_balance: f64 = agent_balance_sum(relayer_metrics_port).unwrap();
    log!("relayer starting balance: {}", starting_relayer_balance);

    let dispatches_per_chain = 5;
    let amount = dispatch_transfers(
        &chain_registry,
        &routers,
        dispatches_per_chain,
        RELAYER_ADDRESS,
    )
    .await;
    log!("dispatched {} messages", amount);

    let config = Config::load();
    let loop_start = Instant::now();
    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            termination_invariants_met(
                &config,
                starting_relayer_balance,
                dispatches_per_chain * chain_registry.chains.len(),
            )
        },
        || !SHUTDOWN.load(Ordering::Relaxed),
        || false,
    );

    if !test_passed {
        panic!("Sovereign E2E tests failed");
    } else {
        log!("Sovereign E2E tests passed");
    }
}

fn wait_until_nodes_healthy(params: &[SovereignParameters]) {
    let timeout_duration = Duration::from_secs(30);
    let check_interval = Duration::from_secs(2);
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

#[cfg(feature = "sovereign")]
#[cfg(test)]
mod test {
    #[tokio::test]
    async fn test_run() {
        crate::sovereign::run_locally().await;
    }
}
