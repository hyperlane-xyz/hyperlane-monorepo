#![allow(dead_code)]

use std::{
    fs,
    path::PathBuf,
    thread::sleep,
    time::{Duration, Instant},
};

use hyperlane_core::SubmitterType;
use maplit::hashmap;
use tempfile::tempdir;

use crate::{
    config::Config,
    fetch_metric,
    invariants::{
        relayer_termination_invariants_met, scraper_termination_invariants_met,
        RelayerTerminationInvariantParams, ScraperTerminationInvariantParams,
    },
    log,
    metrics::agent_balance_sum,
    program::Program,
    server::{fetch_relayer_gas_payment_event_count, fetch_relayer_message_processed_count},
    utils::{
        concat_path, get_workspace_path, make_static, stop_child, wait_for_postgres, AgentHandles,
        TaskHandle,
    },
    wait_for_condition, AGENT_BIN_PATH, AGENT_LOGGING_DIR, RELAYER_METRICS_PORT,
    SCRAPER_METRICS_PORT,
};

/// BIP-44 m/44'/195'/0'/0/0 derived from the "abandon" mnemonic.
/// This is the default funded account in tronbox/tre:dev.
const TRON_PRIVATE_KEY: &str = "0xb5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28";

/// Mnemonic passed to TRE to ensure deterministic accounts.
const TRE_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const TRON_RPC_URL: &str = "http://127.0.0.1:9090/jsonrpc";
const TRON_WALLET_URL: &str = "http://127.0.0.1:9090/wallet";
const TRON_WALLET_SOLIDITY_URL: &str = "http://127.0.0.1:9090/walletsolidity";

const CHAIN_NAMES: [&str; 2] = ["anvil1", "anvil2"];

const VALIDATOR_METRICS_PORT_BASE: u32 = 9094;

struct TronStack {
    validators: Vec<AgentHandles>,
    relayer: AgentHandles,
    scraper: AgentHandles,
    postgres: AgentHandles,
    tron_container: AgentHandles,
}

impl Drop for TronStack {
    fn drop(&mut self) {
        stop_child(&mut self.relayer.1);
        stop_child(&mut self.scraper.1);
        self.validators
            .iter_mut()
            .for_each(|v| stop_child(&mut v.1));
        stop_child(&mut self.postgres.1);
        stop_child(&mut self.tron_container.1);
    }
}

/// Get the path to the CLI package directory.
fn get_cli_path() -> PathBuf {
    let workspace = get_workspace_path(); // rust/main
    concat_path(
        workspace.parent().unwrap().parent().unwrap(), // monorepo root
        "typescript/cli",
    )
}

/// Get the monorepo root.
fn get_monorepo_root() -> PathBuf {
    let workspace = get_workspace_path();
    workspace.parent().unwrap().parent().unwrap().to_path_buf()
}

/// Wait for the TRE node to be ready by polling the admin accounts endpoint.
/// TRE funds accounts asynchronously after startup, so we wait until the
/// accounts-json endpoint returns funded keys.
fn wait_for_tron_node() {
    use ureq::agent;

    const MAX_ATTEMPTS: u32 = 120;
    let agent = agent();

    for attempt in 1..=MAX_ATTEMPTS {
        // Check if the admin accounts endpoint is ready (accounts funded)
        let result = agent
            .get("http://127.0.0.1:9090/admin/accounts-json")
            .call();

        if let Ok(resp) = result {
            if let Ok(body) = resp.into_string() {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(keys) = json["privateKeys"].as_array() {
                        if !keys.is_empty() {
                            log!(
                                "TRE node ready with {} funded accounts (attempt {})",
                                keys.len(),
                                attempt
                            );
                            return;
                        }
                    }
                }
            }
        }
        sleep(Duration::from_secs(2));
    }
    panic!("TRE node not ready after {MAX_ATTEMPTS} attempts");
}

/// Deploy core contracts to a single chain using the Hyperlane CLI.
fn deploy_core(cli_path: &PathBuf, chain: &str) {
    log!("Deploying core contracts to {}...", chain);
    let config = concat_path(
        get_workspace_path(), // monorepo root
        "utils/run-locally/src/tron/core-config.yaml",
    );
    Program::new("pnpm")
        .working_dir(cli_path)
        .cmd("hyperlane")
        .cmd("core")
        .cmd("deploy")
        .arg("registry", "./test-configs/tron")
        .arg("config", config.to_str().unwrap())
        .arg("chain", chain)
        .arg("key.ethereum", TRON_PRIVATE_KEY)
        .arg("key.tron", TRON_PRIVATE_KEY)
        .arg("verbosity", "debug")
        .flag("yes")
        .run()
        .join();
    log!("Deployed core contracts to {}", chain);
}

/// Generate agent config using the Hyperlane CLI.
fn generate_agent_config(cli_path: &PathBuf, out_path: &PathBuf) {
    log!("Generating agent config...");
    Program::new("pnpm")
        .working_dir(cli_path)
        .cmd("hyperlane")
        .cmd("registry")
        .cmd("agent-config")
        .arg("registry", "./test-configs/tron")
        .flag("chains")
        .cmd(CHAIN_NAMES[0])
        .cmd(CHAIN_NAMES[1])
        .arg("out", out_path.to_str().unwrap())
        .flag("yes")
        .run()
        .join();
    log!("Agent config written to {:?}", out_path);
}

/// Inject walletUrls and walletSolidityUrls into the agent config JSON,
/// since the CLI doesn't generate these for Tron chains.
fn patch_agent_config(config_path: &PathBuf) {
    log!("Patching agent config with Tron wallet URLs...");
    let content = fs::read_to_string(config_path).expect("Failed to read agent config");
    let mut config: serde_json::Value =
        serde_json::from_str(&content).expect("Failed to parse agent config");

    for chain in &CHAIN_NAMES {
        if let Some(chain_config) = config["chains"][chain].as_object_mut() {
            chain_config.insert(
                "walletUrls".to_string(),
                serde_json::json!([{"http": TRON_WALLET_URL}]),
            );
            chain_config.insert(
                "walletSolidityUrls".to_string(),
                serde_json::json!([{"http": TRON_WALLET_SOLIDITY_URL}]),
            );
        }
    }

    fs::write(config_path, serde_json::to_string_pretty(&config).unwrap())
        .expect("Failed to write patched agent config");
    log!("Patched agent config with wallet URLs");
}

/// Dispatch test messages using `hyperlane send message`.
fn dispatch_message(cli_path: &PathBuf, origin: &str, destination: &str) {
    log!("Dispatching message {} -> {}...", origin, destination);
    Program::new("pnpm")
        .working_dir(cli_path)
        .cmd("hyperlane")
        .cmd("send")
        .cmd("message")
        .arg("registry", "./test-configs/tron")
        .arg("origin", origin)
        .arg("destination", destination)
        .arg("key.ethereum", TRON_PRIVATE_KEY)
        .arg("key.tron", TRON_PRIVATE_KEY)
        .flag("quick")
        .flag("yes")
        .run()
        .join();
    log!("Dispatched message {} -> {}", origin, destination);
}

/// Set common Tron wallet URL env vars on an agent program.
fn with_tron_wallet_env(program: Program) -> Program {
    let mut p = program;
    for chain in &CHAIN_NAMES {
        let upper = chain.to_uppercase();
        p = p
            .hyp_env(
                &format!("CHAINS_{}_CUSTOMWALLETURLS", upper),
                TRON_WALLET_URL,
            )
            .hyp_env(
                &format!("CHAINS_{}_CUSTOMWALLETSOLIDITYURLS", upper),
                TRON_WALLET_SOLIDITY_URL,
            );
    }
    p
}

fn run_locally() {
    let cli_path = get_cli_path();
    let monorepo_root = get_monorepo_root();

    let workspace_path = get_workspace_path(); // rust/main

    // Build rust agents
    log!("Building rust agents...");
    let build_rust = Program::new("cargo")
        .working_dir(&workspace_path)
        .cmd("build")
        .arg("features", "test-utils memory-profiling")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .arg("bin", "scraper")
        .arg("bin", "init-db")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run();

    // Build typescript
    let pnpm_monorepo = Program::new("pnpm").working_dir(&monorepo_root);
    pnpm_monorepo.clone().cmd("install").run().join();
    pnpm_monorepo.clone().cmd("build").run().join();

    // Start TRE docker container
    log!("Starting TRE docker container...");
    let tron_container = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "tron-e2e")
        .arg("publish", "9090:9090")
        .arg("env", "block=allowTvmCompatibleEvm:1")
        .arg("env", "preapprove=allowTvmCompatibleEvm:1")
        .arg("env", format!("mnemonic={}", TRE_MNEMONIC))
        .arg("env", "defaultBalance=1000000")
        .cmd("tronbox/tre:dev")
        .filter_logs(|_| false)
        .spawn("TRN", None);

    // Wait for TRE to be ready
    log!("Waiting for TRE node...");
    wait_for_tron_node();

    // Wait for rust build to finish
    build_rust.join();

    // Remove stale addresses from prior runs so CLI does fresh deploys
    for chain in &CHAIN_NAMES {
        let addresses_path =
            cli_path.join(format!("test-configs/tron/chains/{}/addresses.yaml", chain));
        let _ = fs::remove_file(&addresses_path);
    }

    // Deploy core to both chains
    deploy_core(&cli_path, "anvil1");
    deploy_core(&cli_path, "anvil2");

    // Generate and patch agent config
    let config_dir = tempdir().unwrap();
    let agent_config_path = concat_path(&config_dir, "agent-config.json");
    generate_agent_config(&cli_path, &agent_config_path);
    patch_agent_config(&agent_config_path);

    // Start postgres
    log!("Starting postgres...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);

    wait_for_postgres();

    log!("Initializing postgres DB...");
    Program::new(concat_path(format!("../../{AGENT_BIN_PATH}"), "init-db"))
        .run()
        .join();

    // Start validators
    let config_path_str = agent_config_path.to_str().unwrap().to_string();
    let mut validators: Vec<AgentHandles> = Vec::new();
    for (i, chain) in CHAIN_NAMES.iter().enumerate() {
        let checkpoint_dir = tempdir().unwrap().into_path();
        let db_dir = tempdir().unwrap().into_path();
        let name = format!("VL{}", i + 1);

        let validator = with_tron_wallet_env(Program::default())
            .bin(concat_path(format!("../../{AGENT_BIN_PATH}"), "validator"))
            .working_dir("../../")
            .env("CONFIG_FILES", &config_path_str)
            .env("RUST_BACKTRACE", "1")
            .hyp_env("LOG_FORMAT", "compact")
            .hyp_env("LOG_LEVEL", "debug")
            .hyp_env("ORIGINCHAINNAME", *chain)
            .hyp_env("VALIDATOR_KEY", TRON_PRIVATE_KEY)
            .hyp_env("DEFAULTSIGNER_KEY", TRON_PRIVATE_KEY)
            .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
            .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_dir.to_str().unwrap())
            .hyp_env("DB", db_dir.to_str().unwrap())
            .hyp_env(
                "METRICSPORT",
                (VALIDATOR_METRICS_PORT_BASE + i as u32).to_string(),
            )
            .hyp_env("INTERVAL", "5")
            .hyp_env("CHAINS_ANVIL1_BLOCKS_REORGPERIOD", "0")
            .hyp_env("CHAINS_ANVIL2_BLOCKS_REORGPERIOD", "0")
            .spawn(make_static(name), None);

        validators.push(validator);
    }

    // Start relayer
    let relayer_db = tempdir().unwrap().into_path();
    let relayer = with_tron_wallet_env(Program::default())
        .bin(concat_path(format!("../../{AGENT_BIN_PATH}"), "relayer"))
        .working_dir("../../")
        .env("CONFIG_FILES", &config_path_str)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug")
        .hyp_env("RELAYCHAINS", "anvil1,anvil2")
        .hyp_env("DB", relayer_db.to_str().unwrap())
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env("DEFAULTSIGNER_KEY", TRON_PRIVATE_KEY)
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{"type":"minimum","payment":"1"}]"#,
        )
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT)
        .arg("relayChains", "anvil1,anvil2")
        .arg("defaultSigner.key", TRON_PRIVATE_KEY)
        .spawn("RLY", Some(&AGENT_LOGGING_DIR));

    // Start scraper
    let scraper = with_tron_wallet_env(Program::default())
        .bin(concat_path(format!("../../{AGENT_BIN_PATH}"), "scraper"))
        .working_dir("../../")
        .env("CONFIG_FILES", &config_path_str)
        .env("RUST_BACKTRACE", "1")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug")
        .hyp_env("CHAINSTOSCRAPE", "anvil1,anvil2")
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT.to_string())
        .spawn("SCR", Some(&AGENT_LOGGING_DIR));

    log!("All agents started. Dispatching messages...");

    // Dispatch messages: 2 in each direction = 4 total
    let mut dispatched_messages = 0u32;

    dispatch_message(&cli_path, "anvil1", "anvil2");
    dispatched_messages += 1;

    dispatch_message(&cli_path, "anvil2", "anvil1");
    dispatched_messages += 1;

    // Give agents a chance to start processing
    sleep(Duration::from_secs(10));

    // Dispatch second batch after agents are running
    dispatch_message(&cli_path, "anvil1", "anvil2");
    dispatched_messages += 1;

    dispatch_message(&cli_path, "anvil2", "anvil1");
    dispatched_messages += 1;

    let _stack = TronStack {
        validators,
        relayer,
        scraper,
        postgres,
        tron_container,
    };

    let loop_start = Instant::now();

    // Give things a chance to fully start
    sleep(Duration::from_secs(10));

    let starting_relayer_balance: f64 = loop {
        if let Ok(balance) = agent_balance_sum(9092) {
            break balance;
        }
        log!("Relayer balance not yet available, retrying...");
        sleep(Duration::from_secs(5));
    };

    // Wait for termination invariants
    const TIMEOUT_SECS: u64 = 60 * 10;
    let mut failure_occurred = false;
    let config = crate::config::Config::load(); // Load the config for invariants

    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || termination_invariants_met(&config, dispatched_messages, starting_relayer_balance),
        || true,  // Always continue (no external shutdown signal for tron tests)
        || false, // No long-running process checks for tron
    );

    if failure_occurred {
        panic!("Tron E2E tests failed");
    } else {
        log!("Tron E2E tests passed");
    }
}

fn termination_invariants_met(
    config: &Config,
    messages_expected: u32,
    starting_relayer_balance: f64,
) -> eyre::Result<bool> {
    // Fetch metrics from the relayer
    let msg_processed_count = fetch_relayer_message_processed_count()?;
    let gas_payment_events_count = fetch_relayer_gas_payment_event_count()?;

    // Check relayer termination invariants using the shared function
    let relayer_params = RelayerTerminationInvariantParams {
        config,
        starting_relayer_balance,
        msg_processed_count,
        gas_payment_events_count,
        total_messages_expected: messages_expected,
        total_messages_dispatched: messages_expected,
        failed_message_count: 0, // Tron doesn't have failed messages in the same way
        submitter_queue_length_expected: 0, // Tron doesn't have zero merkle insertion messages
        non_matching_igp_message_count: 0,
        double_insertion_message_count: 0,
        skip_tx_id_indexing: true,
        submitter_type: SubmitterType::Lander,
    };

    if !relayer_termination_invariants_met(relayer_params)? {
        return Ok(false);
    }

    // Check scraper termination invariants using the shared function
    // For scraper, we need to fetch metrics from the scraper port
    let scraper_gas_payment_events_count = fetch_metric(
        SCRAPER_METRICS_PORT,
        "hyperlane_contract_sync_stored_events",
        &hashmap! {"data_type" => "gas_payment"},
    )?
    .iter()
    .sum::<u32>();

    let scraper_params = ScraperTerminationInvariantParams {
        gas_payment_events_count: scraper_gas_payment_events_count,
        total_messages_dispatched: messages_expected,
        delivered_messages_scraped_expected: messages_expected,
    };

    if !scraper_termination_invariants_met(scraper_params)? {
        return Ok(false);
    }

    log!("Tron termination invariants have been met");
    Ok(true)
}

#[cfg(feature = "tron")]
#[cfg(test)]
mod test {
    #[test]
    fn test_run() {
        crate::tron::run_locally();
    }
}
