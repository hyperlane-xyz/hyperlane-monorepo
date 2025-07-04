pub mod sealevel_termination_invariants;
pub mod solana;

use std::{
    fs,
    path::Path,
    sync::atomic::Ordering,
    thread::sleep,
    time::{Duration, Instant},
};

use hyperlane_core::SubmitterType;
use tempfile::tempdir;

use crate::SHUTDOWN;
use crate::{
    config::Config,
    invariants::post_startup_invariants,
    logging::log,
    long_running_processes_exited_check,
    metrics::agent_balance_sum,
    program::Program,
    sealevel::{sealevel_termination_invariants::*, solana::*},
    utils::{
        concat_path, get_sealevel_path, get_ts_infra_path, get_workspace_path, make_static,
        TaskHandle,
    },
    wait_for_condition, State, AGENT_LOGGING_DIR, RELAYER_METRICS_PORT, SCRAPER_METRICS_PORT,
};

// This number should be even, so the messages can be split into two equal halves
// sent before and after the relayer spins up, to avoid rounding errors.
pub const SOL_MESSAGES_EXPECTED: u32 = 10;
pub const SOL_MESSAGES_WITH_NON_MATCHING_IGP: u32 = 1;
pub const SUBMITTER_TYPE: SubmitterType = SubmitterType::Lander;

/// These private keys are from the solana-test-validator network
const RELAYER_KEYS: &[&str] = &[
    // sealeveltest1
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
    // sealeveltest2
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
];

const SEALEVEL_VALIDATOR_KEYS: &[&str] = &[
    // sealevel
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];

type DynPath = Box<dyn AsRef<Path>>;

#[allow(dead_code)]
fn run_locally() {
    // on sigint we want to trigger things to stop running
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    let config = Config::load();
    log!("Running with config: {:?}", config);

    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);
    let ts_infra_path = get_ts_infra_path();
    log!(
        "Paths:\n{:?}\n{:?}\n{:?}",
        workspace_path,
        sealevel_path,
        ts_infra_path
    );

    let validator_origin_chains = ["sealeveltest1"].to_vec();
    let validator_keys = SEALEVEL_VALIDATOR_KEYS.to_vec();
    let validator_count: usize = validator_keys.len();

    let solana_checkpoint_path = Path::new(SOLANA_CHECKPOINT_LOCATION);
    fs::remove_dir_all(solana_checkpoint_path).unwrap_or_default();
    let checkpoints_dirs: Vec<DynPath> = vec![Box::new(solana_checkpoint_path) as DynPath];

    assert_eq!(validator_origin_chains.len(), validator_keys.len());

    let rocks_db_dir = tempdir().expect("Failed to create tempdir for rocksdb");
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_dbs = (0..validator_count)
        .map(|i| concat_path(&rocks_db_dir, format!("validator{i}")))
        .collect::<Vec<_>>();

    let common_agent_env = Program::default()
        .env("RUST_BACKTRACE", "full")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug");

    let relayer_env = common_agent_env
        .clone()
        .bin(concat_path(&workspace_path, "target/debug/relayer"))
        .working_dir(&workspace_path)
        .hyp_env("METRICSPORT", RELAYER_METRICS_PORT)
        .hyp_env("DB", relayer_db.to_str().unwrap())
        .hyp_env("CHAINS_SEALEVELTEST1_SIGNER_KEY", RELAYER_KEYS[0])
        .hyp_env("CHAINS_SEALEVELTEST2_SIGNER_KEY", RELAYER_KEYS[1])
        .hyp_env("CHAINS_SEALEVELTEST1_SUBMITTER", SUBMITTER_TYPE.to_string())
        .hyp_env("CHAINS_SEALEVELTEST2_SUBMITTER", SUBMITTER_TYPE.to_string())
        .hyp_env("RELAYCHAINS", "invalidchain,otherinvalid")
        .hyp_env("ALLOWLOCALCHECKPOINTSYNCERS", "true")
        .hyp_env(
            "GASPAYMENTENFORCEMENT",
            r#"[{
                "type": "minimum",
                "payment": "1"
            }]"#,
        )
        .arg("defaultSigner.key", RELAYER_KEYS[0])
        .arg("relayChains", "sealeveltest1,sealeveltest2");

    let base_validator_env = common_agent_env
        .clone()
        .bin(concat_path(&workspace_path, "target/debug/validator"))
        .working_dir(&workspace_path)
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

    log!("Relayer DB in {}", relayer_db.display());
    (0..validator_count).for_each(|i| {
        log!("Validator {} DB in {}", i + 1, validator_dbs[i].display());
    });

    let scraper_env = common_agent_env
        .bin(concat_path(&workspace_path, "target/debug/scraper"))
        .working_dir(&workspace_path)
        .hyp_env("METRICSPORT", SCRAPER_METRICS_PORT)
        .hyp_env(
            "DB",
            "postgresql://postgres:47221c18c610@localhost:5432/postgres",
        )
        .hyp_env("CHAINSTOSCRAPE", "sealeveltest1,sealeveltest2");

    let mut state = State::default();

    log!(
        "Signed checkpoints in {}",
        checkpoints_dirs
            .iter()
            .map(|d| (**d).as_ref().display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );

    //
    // Ready to run...
    //

    let (solana_programs_path, hyperlane_solana_programs_path) = {
        let solana_path_tempdir = tempdir().expect("Failed to create solana temp dir");
        let solana_bin_path = install_solana_cli_tools(
            SOLANA_CONTRACTS_CLI_RELEASE_URL.to_owned(),
            SOLANA_CONTRACTS_CLI_VERSION.to_owned(),
            solana_path_tempdir.path().to_path_buf(),
        )
        .join();
        state.data.push(Box::new(solana_path_tempdir));

        let solana_program_builder = build_solana_programs(solana_bin_path.clone());
        (solana_bin_path, solana_program_builder.join())
    };

    // this task takes a long time in the CI so run it in parallel
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

    log!("Building hyperlane-sealevel-client...");
    Program::new("cargo")
        .working_dir(&sealevel_path)
        .cmd("build")
        .arg("bin", "hyperlane-sealevel-client")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run()
        .join();

    let solana_ledger_dir = tempdir().expect("Failed to create solana ledger dir");
    let (solana_cli_tools_path, solana_config_path) = {
        // use the agave 2.x validator version to ensure mainnet compatibility
        let solana_tools_dir = tempdir().expect("Failed to create solana tools dir");
        let solana_bin_path = install_solana_cli_tools(
            SOLANA_NETWORK_CLI_RELEASE_URL.to_owned(),
            SOLANA_NETWORK_CLI_VERSION.to_owned(),
            solana_tools_dir.path().to_path_buf(),
        )
        .join();
        state.data.push(Box::new(solana_tools_dir));

        let start_solana_validator = start_solana_test_validator(
            solana_bin_path.clone(),
            hyperlane_solana_programs_path.clone(),
            solana_ledger_dir.as_ref().to_path_buf(),
        );

        let (solana_config_path, solana_validator) = start_solana_validator.join();
        state.push_agent(solana_validator);
        (solana_bin_path, solana_config_path)
    };

    sleep(Duration::from_secs(5));

    log!("Init postgres db...");
    Program::new(concat_path(&workspace_path, "target/debug/init-db"))
        .working_dir(&workspace_path)
        .run()
        .join();
    state.push_agent(scraper_env.spawn("SCR", None));

    // sleep some more to avoid flakes when sending transfers below
    sleep(Duration::from_secs(10));

    // Send some sealevel messages before spinning up the agents, to test the backward indexing cursor
    for _i in 0..(SOL_MESSAGES_EXPECTED / 2) {
        initiate_solana_hyperlane_transfer(
            solana_cli_tools_path.clone(),
            solana_config_path.clone(),
        )
        .join();
    }

    // spawn validators
    for (i, validator_env) in validator_envs.into_iter().enumerate() {
        let validator = validator_env.spawn(
            make_static(format!("VL{}", 1 + i)),
            Some(AGENT_LOGGING_DIR.as_ref()),
        );
        state.push_agent(validator);
    }

    // spawn relayer
    state.push_agent(relayer_env.spawn("RLY", Some(&AGENT_LOGGING_DIR)));

    // Send some sealevel messages before spinning up the agents, to test the backward indexing cursor
    for _i in 0..(SOL_MESSAGES_EXPECTED / 2) {
        initiate_solana_hyperlane_transfer(
            solana_cli_tools_path.clone(),
            solana_config_path.clone(),
        )
        .join();
    }

    initiate_solana_non_matching_igp_paying_transfer(
        solana_cli_tools_path.clone(),
        solana_config_path.clone(),
    )
    .join();

    log!("Setup complete! Agents running in background...");
    log!("Ctrl+C to end execution...");

    let loop_start = Instant::now();
    // give things a chance to fully start.
    sleep(Duration::from_secs(10));

    if !post_startup_invariants(&checkpoints_dirs) {
        panic!("Failure: Post startup invariants are not met");
    } else {
        log!("Success: Post startup invariants are met");
    }

    let starting_relayer_balance: f64 = agent_balance_sum(9092).unwrap();

    // wait for CI invariants to pass
    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            termination_invariants_met(
                &config,
                starting_relayer_balance,
                &solana_programs_path,
                &solana_config_path,
                SUBMITTER_TYPE,
            )
        },
        || !SHUTDOWN.load(Ordering::Relaxed),
        || long_running_processes_exited_check(&mut state),
    );

    if !test_passed {
        panic!("Failure occurred during E2E");
    }
    log!("E2E tests passed");
}

#[cfg(test)]
#[cfg(feature = "sealevel")]
mod test {

    #[test]
    fn test_run() {
        use crate::sealevel::run_locally;

        run_locally()
    }
}
