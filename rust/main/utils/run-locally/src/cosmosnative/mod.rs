#![allow(dead_code)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    thread::sleep,
    time::{Duration, Instant},
};

use cli::SimApp;
use constants::{ALICE_HEX, BINARY_NAME, KEY_CHAIN_VALIDATOR, KEY_RELAYER, KEY_VALIDATOR, PREFIX};
use macro_rules_attribute::apply;
use maplit::hashmap;
use tempfile::tempdir;
use types::{AgentConfig, AgentConfigOut, Deployment};

use crate::{
    fetch_metric, log,
    metrics::agent_balance_sum,
    program::Program,
    utils::{as_task, concat_path, stop_child, AgentHandles, TaskHandle},
    AGENT_BIN_PATH,
};

mod cli;
mod constants;
mod types;

pub struct CosmosNativeStack {
    pub validators: Vec<AgentHandles>,
    pub relayer: AgentHandles,
    pub scraper: AgentHandles,
    pub postgres: AgentHandles,
    pub nodes: Vec<Deployment>,
}

// this is for clean up
// kills all the remaining children
impl Drop for CosmosNativeStack {
    fn drop(&mut self) {
        stop_child(&mut self.relayer.1);
        stop_child(&mut self.scraper.1);
        stop_child(&mut self.postgres.1);
        self.validators
            .iter_mut()
            .for_each(|x| stop_child(&mut x.1));
        self.nodes
            .iter_mut()
            .for_each(|x| stop_child(&mut x.handle.1));
    }
}

/// right now we only test two chains that communicate with each other
///
/// we send a one uhyp from node1 -> node2, this will result in a wrapped uhyp on node2
/// we send a one uhyp from node2 -> node1, this will result in a wrapped uhyp on node1
fn dispatch(node1: &Deployment, node2: &Deployment) -> u32 {
    (0..2)
        .map(|_| {
            node1.chain.remote_transfer(
                KEY_CHAIN_VALIDATOR.0,
                &node1.contracts.tokens[0],
                &node2.domain.to_string(),
                ALICE_HEX,
                1000000u32,
            );
            node2.chain.remote_transfer(
                KEY_CHAIN_VALIDATOR.0,
                &node2.contracts.tokens[0],
                &node1.domain.to_string(),
                ALICE_HEX,
                1000000u32,
            );
            2u32
        })
        .sum()
}

#[apply(as_task)]
fn launch_cosmos_validator(agent_config: AgentConfig, agent_config_path: PathBuf) -> AgentHandles {
    let validator_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "validator");
    let validator_base = tempdir().expect("Failed to create a temp dir").into_path();
    let validator_base_db = concat_path(&validator_base, "db");

    fs::create_dir_all(&validator_base_db).unwrap();
    println!("Validator DB: {:?}", validator_base_db);

    let checkpoint_path = concat_path(&validator_base, "checkpoint");
    let signature_path = concat_path(&validator_base, "signature");

    let validator = Program::default()
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
        .hyp_env("VALIDATOR_KEY", KEY_VALIDATOR.1)
        .hyp_env("DEFAULTSIGNER_KEY", KEY_VALIDATOR.1)
        .hyp_env("DEFAULTSIGNER_TYPE", "cosmosKey")
        .hyp_env("DEFAULTSIGNER_PREFIX", PREFIX)
        .spawn("VAL", None);

    validator
}

#[apply(as_task)]
fn launch_cosmos_relayer(
    agent_config_path: String,
    relay_chains: Vec<String>,
    metrics: u32,
) -> AgentHandles {
    let relayer_bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer");
    let relayer_base = tempdir().unwrap();

    let relayer = Program::default()
        .bin(relayer_bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("RELAYCHAINS", relay_chains.join(","))
        .hyp_env("DB", relayer_base.as_ref().to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("DEFAULTSIGNER_KEY", KEY_RELAYER.1)
        .hyp_env("DEFAULTSIGNER_TYPE", "cosmosKey")
        .hyp_env("DEFAULTSIGNER_PREFIX", PREFIX)
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("RLY", None);

    relayer
}

#[apply(as_task)]
fn launch_cosmos_scraper(
    agent_config_path: String,
    chains: Vec<String>,
    metrics: u32,
) -> AgentHandles {
    let bin = concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper");

    let scraper = Program::default()
        .bin(bin)
        .working_dir("../../")
        .env("CONFIG_FILES", agent_config_path)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("CHAINSTOSCRAPE", chains.join(","))
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("METRICSPORT", metrics.to_string())
        .spawn("SCR", None);

    scraper
}

fn make_target() -> String {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        panic!("Current os is not supported by HypD")
    };

    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };

    format!("{}_{}", os, arch)
}

fn install_sim_app() -> PathBuf {
    let target = make_target();

    let dir_path = tempdir().unwrap().into_path();
    let dir_path = dir_path.to_str().unwrap();

    let release_name = format!("{BINARY_NAME}_{target}");
    log!("Downloading Sim App {}", release_name);
    let uri = format!(
        "https://github.com/bcp-innovations/hyperlane-cosmos/releases/download/v1.0.0/{}",
        release_name
    );

    Program::new("curl")
        .arg("output", BINARY_NAME)
        .flag("location")
        .cmd(uri)
        // .flag("silent")
        .working_dir(dir_path)
        .run()
        .join();

    Program::new("chmod")
        .cmd("+x")
        .cmd(BINARY_NAME)
        .working_dir(dir_path)
        .run()
        .join();

    concat_path(dir_path, BINARY_NAME)
}

#[allow(dead_code)]
fn run_locally() {
    // TODO: store all the created processes directly to not have lost children on crash
    let hypd = install_sim_app().as_path().to_str().unwrap().to_string();

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

    let metrics_port_start = 9090u32;
    let domain_start = 75898670u32;
    let node_count = 2; // right now this only works with two nodes.

    let nodes = (0..node_count)
        .map(|i| {
            let node_dir = tempdir().unwrap().path().to_str().unwrap().to_string();
            let mut node = SimApp::new(hypd.to_owned(), node_dir, i);
            node.init();
            let handle = node.start();
            let contracts = node.deploy_and_configure_contracts(
                &format!("{}", domain_start + i),
                &format!("{}", domain_start + (i + 1) % node_count),
            );
            Deployment {
                chain: node,
                domain: domain_start + i,
                metrics: metrics_port_start + i,
                name: format!("cosmostestnative{}", i + 1),
                contracts,
                handle,
            }
        })
        .collect::<Vec<Deployment>>();

    let node1 = &nodes[0];
    let node2 = &nodes[1];

    // Mostly copy-pasta from `rust/main/utils/run-locally/src/main.rs`

    // count all the dispatched messages
    let mut dispatched_messages = 0;
    // dispatch the first batch of messages (before agents start)
    dispatched_messages += dispatch(node1, node2);

    let config_dir = tempdir().unwrap();
    // export agent config
    let agent_config_out = AgentConfigOut {
        chains: nodes
            .iter()
            .map(|v| (v.name.clone(), AgentConfig::new(v)))
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
        .map(|agent_config| launch_cosmos_validator(agent_config, agent_config_path.clone()))
        .collect::<Vec<_>>();

    let chains = agent_config_out.chains.into_keys().collect::<Vec<_>>();
    let path = agent_config_path.to_str().unwrap();

    let hpl_rly_metrics_port = metrics_port_start + node_count;
    let hpl_rly = launch_cosmos_relayer(path.to_owned(), chains.clone(), hpl_rly_metrics_port);

    let hpl_scr_metrics_port = hpl_rly_metrics_port + 1u32;
    let hpl_scr = launch_cosmos_scraper(path.to_owned(), chains.clone(), hpl_scr_metrics_port);

    // give things a chance to fully start.
    sleep(Duration::from_secs(20));

    let starting_relayer_balance: f64 = agent_balance_sum(hpl_rly_metrics_port).unwrap();

    // dispatch the second batch of messages (after agents start)
    dispatched_messages += dispatch(node1, node2);

    let _stack = CosmosNativeStack {
        validators: hpl_val.into_iter().map(|v| v.join()).collect(),
        relayer: hpl_rly.join(),
        scraper: hpl_scr.join(),
        postgres,
        nodes,
    };

    // TODO: refactor to share code
    let loop_start = Instant::now();
    let mut failure_occurred = false;
    const TIMEOUT_SECS: u64 = 60 * 10;
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

fn termination_invariants_met(
    relayer_metrics_port: u32,
    scraper_metrics_port: u32,
    messages_expected: u32,
    starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    let expected_gas_payments = messages_expected;
    let gas_payments_event_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_event_count != expected_gas_payments {
        log!(
            "Relayer has indexed {} gas payments, expected {}",
            gas_payments_event_count,
            expected_gas_payments
        );
        return Ok(false);
    }

    let msg_processed_count = fetch_metric(
        &relayer_metrics_port.to_string(),
        "hyperlane_operations_processed_count",
        &hashmap! {"phase" => "confirmed"},
    )?
    .iter()
    .sum::<u32>();
    if msg_processed_count != messages_expected {
        log!(
            "Relayer confirmed {} submitted messages, expected {}",
            msg_processed_count,
            messages_expected
        );
        return Ok(false);
    }

    let ending_relayer_balance: f64 = agent_balance_sum(relayer_metrics_port).unwrap();

    // Make sure the balance was correctly updated in the metrics.
    // Ideally, make sure that the difference is >= gas_per_tx * gas_cost, set here:
    // https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/c2288eb31734ba1f2f997e2c6ecb30176427bc2c/rust/utils/run-locally/src/cosmos/cli.rs#L55
    // What's stopping this is that the format returned by the `uosmo` balance query is a surprisingly low number (0.000003999999995184)
    // but then maybe the gas_per_tx is just very low - how can we check that? (maybe by simulating said tx)
    if starting_relayer_balance <= ending_relayer_balance {
        log!(
            "Expected starting relayer balance to be greater than ending relayer balance, but got {} <= {}",
            starting_relayer_balance,
            ending_relayer_balance
        );
        return Ok(false);
    }

    let dispatched_messages_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_dispatch"},
    )?
    .iter()
    .sum::<u32>();
    if dispatched_messages_scraped != messages_expected {
        log!(
            "Scraper has scraped {} dispatched messages, expected {}",
            dispatched_messages_scraped,
            messages_expected
        );
        return Ok(false);
    }

    let gas_payments_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();
    if gas_payments_scraped != expected_gas_payments {
        log!(
            "Scraper has scraped {} gas payments, expected {}",
            gas_payments_scraped,
            expected_gas_payments
        );
        return Ok(false);
    }

    let delivered_messages_scraped = fetch_metric(
        &scraper_metrics_port.to_string(),
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "message_delivery"},
    )?
    .iter()
    .sum::<u32>();
    if delivered_messages_scraped != messages_expected {
        log!(
            "Scraper has scraped {} delivered messages, expected {}",
            delivered_messages_scraped,
            messages_expected
        );
        return Ok(false);
    }

    log!("Termination invariants have been meet");
    Ok(true)
}

#[cfg(feature = "cosmosnative")]
#[cfg(test)]
mod test {
    #[test]
    fn test_run() {
        use crate::cosmosnative::run_locally;

        run_locally();
    }
}
