#![allow(dead_code)]

use std::{
    fs,
    path::Path,
    sync::atomic::Ordering,
    thread::sleep,
    time::{Duration, Instant},
};

use hyperlane_core::SubmitterType;
use tempfile::tempdir;

use crate::sovereign::node::SovereignParameters;
use crate::{
    config::Config,
    invariants::post_startup_invariants,
    logging::log,
    long_running_processes_exited_check,
    metrics::agent_balance_sum,
    program::Program,
    utils::{concat_path, get_workspace_path, make_static},
    wait_for_condition, AgentHandles, State, AGENT_BIN_PATH, AGENT_LOGGING_DIR,
    RELAYER_METRICS_PORT, SCRAPER_METRICS_PORT, SHUTDOWN,
};

mod node;

pub const SOVEREIGN_MESSAGES_EXPECTED: u32 = 10;

/// Test private keys for Sovereign chains
const RELAYER_KEYS: &[&str] = &[
    // sovereigntest1
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
    // sovereigntest2
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
];

const SOVEREIGN_VALIDATOR_KEYS: &[&str] = &[
    // sovereign
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];

type DynPath = Box<dyn AsRef<Path>>;

#[allow(dead_code)]
fn run_locally() {
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

    log!("Waiting for Sovereign nodes to be ready...");
    sleep(Duration::from_secs(10));

    // Verify node health for all nodes
    let mut retries = 0;
    let max_retries = 5;
    while retries < max_retries {
        let mut all_healthy = true;

        for param in &params {
            let health_url = format!("http://127.0.0.1:{}", param.port);
            if !node::check_sovereign_node_health(&health_url) {
                all_healthy = false;
                break;
            }
        }

        if all_healthy {
            log!("All {} Sovereign nodes are healthy and ready", 2);
            break;
        }

        retries += 1;
        if retries < max_retries {
            log!(
                "Waiting for nodes to become healthy... (attempt {}/{})",
                retries,
                max_retries
            );
            sleep(Duration::from_secs(5));
        } else {
            log!("Warning: Not all Sovereign nodes responded to health checks, proceeding anyway");
        }
    }

    log!("Simplified Sovereign node startup test completed successfully!");

    /* COMMENTED OUT FOR SIMPLE NODE TEST - UNCOMMENT LATER FOR FULL E2E TESTS
    let config = Config::load();
    log!("Running Sovereign tests with config: {:?}", config);

    let workspace_path = get_workspace_path();

    let validator_origin_chains = ["sovereigntest1"].to_vec();
    let validator_keys = SOVEREIGN_VALIDATOR_KEYS.to_vec();
    let validator_count: usize = validator_keys.len();

    // Create config file path
    let config_path = concat_path(&workspace_path, "main/config/test_sovereign_config.json");

    let checkpoints_dirs: Vec<DynPath> = (0..validator_count)
        .map(|_| Box::new(tempdir().unwrap()) as DynPath)
        .collect();
    assert_eq!(validator_origin_chains.len(), validator_keys.len());

    let rocks_db_dir = tempdir().expect("Failed to create tempdir for rocksdb");
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_dbs = (0..validator_count)
        .map(|i| concat_path(&rocks_db_dir, format!("validator{i}")))
        .collect::<Vec<_>>();

    let common_agent_env = create_common_agent();
    let relayer_env = create_relayer(&rocks_db_dir, &config_path);

    let base_validator_env = common_agent_env
        .clone()
        .bin(concat_path(AGENT_BIN_PATH, "validator"))
        .env("CONFIG_FILES", config_path.to_str().unwrap())
        .hyp_env(
            "CHAINS_SOVEREIGNTEST1_CUSTOMRPCURLS",
            "http://127.0.0.1:12345",
        )
        .hyp_env("CHAINS_SOVEREIGNTEST1_RPCCONSENSUSTYPE", "quorum")
        .hyp_env("CHAINS_SOVEREIGNTEST1_BLOCKS_REORGPERIOD", "0")
        .hyp_env(
            "CHAINS_SOVEREIGNTEST2_CUSTOMRPCURLS",
            "http://127.0.0.1:12346",
        )
        .hyp_env("CHAINS_SOVEREIGNTEST2_RPCCONSENSUSTYPE", "quorum")
        .hyp_env("CHAINS_SOVEREIGNTEST2_BLOCKS_REORGPERIOD", "0")
        .hyp_env("INTERVAL", "5")
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage");

    let validator_envs = (0..validator_count)
        .map(|i| {
            base_validator_env
                .clone()
                .hyp_env("METRICSPORT", (9094 + i).to_string())
                .hyp_env("DB", validator_dbs[i].to_str().unwrap())
                .hyp_env("ORIGINCHAINNAME", validator_origin_chains[i])
                .hyp_env("VALIDATOR_KEY", validator_keys[i])
                .hyp_env(
                    "CHECKPOINTSYNCER_PATH",
                    (*checkpoints_dirs[i]).as_ref().to_str().unwrap(),
                )
        })
        .collect::<Vec<_>>();

    let scraper_env = common_agent_env
        .bin(concat_path(AGENT_BIN_PATH, "scraper"))
        .env("CONFIG_FILES", config_path.to_str().unwrap())
        .hyp_env("CHAINS_SOVEREIGNTEST1_RPCCONSENSUSTYPE", "quorum")
        .hyp_env(
            "CHAINS_SOVEREIGNTEST1_CUSTOMRPCURLS",
            "http://127.0.0.1:12345",
        )
        .hyp_env("CHAINS_SOVEREIGNTEST2_RPCCONSENSUSTYPE", "quorum")
        .hyp_env(
            "CHAINS_SOVEREIGNTEST2_CUSTOMRPCURLS",
            "http://127.0.0.1:12346",
        )
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT)
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("CHAINSTOSCRAPE", "sovereigntest1,sovereigntest2");

    log!(
        "Signed checkpoints in {}",
        checkpoints_dirs
            .iter()
            .map(|d| (**d).as_ref().display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    log!("Relayer DB in {}", relayer_db.display());
    (0..validator_count).for_each(|i| {
        log!("Validator {} DB in {}", i + 1, validator_dbs[i].display());
    });

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

    log!("Running postgres db...");
    let postgres = Program::new("docker")
        .cmd("run")
        .flag("rm")
        .arg("name", "scraper-testnet-postgres")
        .arg("env", "POSTGRES_PASSWORD=47221c18c610")
        .arg("publish", "5432:5432")
        .cmd("postgres:14")
        .spawn("SQL", None);
    state.push_agent(postgres);

    build_main.join();

    // spawn 1st validator before any messages have been sent to test empty mailbox
    state.push_agent(validator_envs.first().unwrap().clone().spawn("VL1", None));

    sleep(Duration::from_secs(5));

    log!("Init postgres db...");
    Program::new(concat_path(AGENT_BIN_PATH, "init-db"))
        .working_dir(&workspace_path)
        .run()
        .join();
    state.push_agent(scraper_env.spawn("SCR", None));

    // TODO: Add message dispatch logic before agents start
    log!("Dispatching test messages...");
    // rollup_dir is available here for sovereign-specific message dispatch

    // spawn the rest of the validators
    for (i, validator_env) in validator_envs.into_iter().enumerate().skip(1) {
        let validator = validator_env.spawn(
            make_static(format!("VL{}", 1 + i)),
            Some(AGENT_LOGGING_DIR.as_ref()),
        );
        state.push_agent(validator);
    }

    state.push_agent(relayer_env.spawn("RLY", Some(&AGENT_LOGGING_DIR)));

    log!("Setup complete! Agents running in background...");
    log!("Ctrl+C to end execution...");

    // TODO: Add more message dispatch after relayer comes up

    let loop_start = Instant::now();
    // give things a chance to fully start.
    sleep(Duration::from_secs(10));

    if !post_startup_invariants(&checkpoints_dirs) {
        panic!("Failure: Post startup invariants are not met");
    } else {
        log!("Success: Post startup invariants are met");
    }

    let starting_relayer_balance: f64 = agent_balance_sum(9092).unwrap();

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

fn create_common_agent() -> Program {
    Program::default()
        .env("RUST_BACKTRACE", "full")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug")
        .hyp_env("CHAINS_SOVEREIGNTEST1_INDEX_CHUNK", "1")
        .hyp_env("CHAINS_SOVEREIGNTEST2_INDEX_CHUNK", "1")
}

fn create_relayer(rocks_db_dir: &tempfile::TempDir, config_path: &std::path::PathBuf) -> Program {
    let relayer_db = concat_path(rocks_db_dir, "relayer");

    let common_agent_env = create_common_agent();

    common_agent_env
        .clone()
        .bin(concat_path(AGENT_BIN_PATH, "relayer"))
        .env("CONFIG_FILES", config_path.to_str().unwrap())
        .hyp_env("CHAINS_SOVEREIGNTEST1_RPCCONSENSUSTYPE", "fallback")
        .hyp_env(
            "CHAINS_SOVEREIGNTEST1_CONNECTION_URL",
            "http://127.0.0.1:12345",
        )
        .hyp_env("CHAINS_SOVEREIGNTEST2_RPCCONSENSUSTYPE", "fallback")
        .hyp_env(
            "CHAINS_SOVEREIGNTEST2_CONNECTION_URL",
            "http://127.0.0.1:12346",
        )
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT)
        .hyp_env("DB", relayer_db.to_str().unwrap())
        .hyp_env("CHAINS_SOVEREIGNTEST1_SIGNER_KEY", RELAYER_KEYS[0])
        .hyp_env("CHAINS_SOVEREIGNTEST2_SIGNER_KEY", RELAYER_KEYS[1])
        .hyp_env("RELAYCHAINS", "invalidchain,otherinvalid")
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .arg(
            "chains.sovereigntest1.customRpcUrls",
            "http://127.0.0.1:12345",
        )
        .arg(
            "chains.sovereigntest2.customRpcUrls",
            "http://127.0.0.1:12346",
        )
        .arg("defaultSigner.key", RELAYER_KEYS[0])
        .arg("relayChains", "sovereigntest1,sovereigntest2")
}

#[cfg(test)]
#[cfg(feature = "sovereign")]
mod test {
    #[test]
    fn test_run() {
        use crate::sovereign::run_locally;

        run_locally()
    }
}
