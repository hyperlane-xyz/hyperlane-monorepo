#![allow(dead_code)]

use std::{
    fs,
    fs::File,
    path::Path,
    sync::atomic::Ordering,
    thread::sleep,
    time::{Duration, Instant},
};

use hyperlane_core::SubmitterType;
use tempfile::{tempdir, NamedTempFile};

use crate::SHUTDOWN;
use crate::{
    config::Config,
    invariants::post_startup_invariants,
    logging::log,
    long_running_processes_exited_check,
    program::Program,
    sealevel::solana::{
        build_solana_programs, initiate_hyperlane_transfer_to_sealeveltest2,
        install_solana_cli_tools, sealevel_client, start_solana_test_validator,
        SEALEVELTEST2_DOMAIN_ID, SEALEVELTEST2_MAILBOX_PROGRAM_ID, SOLANA_CHECKPOINT_LOCATION_2,
        SOLANA_CONTRACTS_CLI_RELEASE_URL, SOLANA_CONTRACTS_CLI_VERSION, SOLANA_ENV_NAME,
    },
    utils::{concat_path, get_sealevel_path, get_workspace_path, TaskHandle},
    wait_for_condition, State, AGENT_LOGGING_DIR, RELAYER_METRICS_PORT,
};

const COMPOSITE_ISM_MESSAGES_EXPECTED: u32 = 2;
const SUBMITTER_TYPE: SubmitterType = SubmitterType::Lander;

// ECDSA address of the test validator on sealeveltest1 (key index 1 in solana-test-validator)
const SEALEVELTEST1_VALIDATOR_ECDSA_ADDR: &str = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

// Numeric domain ID used inside the composite ISM JSON config
const SEALEVELTEST1_DOMAIN_ID_U32: u32 = 13375;

const RELAYER_KEYS: &[&str] = &[
    // sealeveltest1
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
    // sealeveltest2
    "0x892bf6949af4233e62f854cb3618bc1a3ee3341dc71ada08c4d5deca239acf4f",
];

const SEALEVEL_VALIDATOR_KEY: &str =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

type DynPath = Box<dyn AsRef<Path>>;

fn run_locally_composite_ism() {
    ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    })
    .unwrap();

    let config = Config::load();
    log!("Running composite ISM e2e with config: {:?}", config);

    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    // Use the second checkpoint location to avoid collision with the main sealevel e2e test
    let solana_checkpoint_path = Path::new(SOLANA_CHECKPOINT_LOCATION_2);
    fs::remove_dir_all(solana_checkpoint_path).unwrap_or_default();
    let checkpoints_dirs: Vec<DynPath> = vec![Box::new(solana_checkpoint_path) as DynPath];

    let rocks_db_dir = tempdir().expect("Failed to create tempdir for rocksdb");
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_db = concat_path(&rocks_db_dir, "validator0");

    let common_agent_env = Program::default()
        .env("RUST_BACKTRACE", "full")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug");

    // No ALT configured — composite ISM delivery uses legacy transactions only
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
            r#"[{"type": "minimum", "payment": "1"}]"#,
        )
        .hyp_env("CACHEDEFAULTEXPIRATIONSECONDS", "5")
        .arg("defaultSigner.key", RELAYER_KEYS[0])
        .arg("relayChains", "sealeveltest1,sealeveltest2");

    let validator_env = common_agent_env
        .clone()
        .bin(concat_path(&workspace_path, "target/debug/validator"))
        .working_dir(&workspace_path)
        .hyp_env("INTERVAL", "5")
        .hyp_env("CHECKPOINTSYNCER_TYPE", "localStorage")
        .hyp_env("METRICSPORT", "9094")
        .hyp_env("DB", validator_db.to_str().unwrap())
        .hyp_env("ORIGINCHAINNAME", "sealeveltest1")
        .hyp_env("CHAINS_SEALEVELTEST1_SIGNER_KEY", RELAYER_KEYS[0])
        .hyp_env("CHAINS_SEALEVELTEST2_SIGNER_KEY", RELAYER_KEYS[1])
        .hyp_env("VALIDATOR_KEY", SEALEVEL_VALIDATOR_KEY)
        .hyp_env(
            "CHECKPOINTSYNCER_PATH",
            solana_checkpoint_path.to_str().unwrap(),
        );

    let mut state = State::default();

    log!("Signed checkpoints in {}", solana_checkpoint_path.display());

    let solana_path_tempdir = tempdir().expect("Failed to create solana temp dir");
    let solana_cli_tools_path = install_solana_cli_tools(
        SOLANA_CONTRACTS_CLI_RELEASE_URL.to_owned(),
        SOLANA_CONTRACTS_CLI_VERSION.to_owned(),
        solana_path_tempdir.path().to_path_buf(),
    )
    .join();
    state.data.push(Box::new(solana_path_tempdir));

    let hyperlane_solana_programs_path =
        build_solana_programs(solana_cli_tools_path.clone()).join();

    log!("Building rust agents...");
    let build_main = Program::new("cargo")
        .cmd("build")
        .working_dir(&workspace_path)
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run();

    log!("Building hyperlane-sealevel-client...");
    let build_sealevel_client = Program::new("cargo")
        .working_dir(&sealevel_path)
        .cmd("build")
        .arg("bin", "hyperlane-sealevel-client")
        .filter_logs(|l| !l.contains("workspace-inheritance"))
        .run();

    build_main.join();
    build_sealevel_client.join();

    let solana_ledger_dir = tempdir().expect("Failed to create solana ledger dir");
    let solana_config_path = {
        let result = start_solana_test_validator(
            solana_cli_tools_path.clone(),
            hyperlane_solana_programs_path.clone(),
            solana_ledger_dir.as_ref().to_path_buf(),
        )
        .join();
        state.push_agent(result.validator);
        result.config_path
    };

    // sleep to ensure the validator and all programs are fully settled
    sleep(Duration::from_secs(10));

    // Deploy composite ISM to sealeveltest2 and set it as the mailbox default ISM
    let composite_ism_program_id = deploy_and_configure_composite_ism(
        &solana_cli_tools_path,
        &solana_config_path,
        &hyperlane_solana_programs_path,
    );
    log!(
        "Composite ISM program ID on sealeveltest2: {}",
        composite_ism_program_id
    );

    state.push_agent(validator_env.spawn("VL1", Some(AGENT_LOGGING_DIR.as_ref())));
    state.push_agent(relayer_env.spawn("RLY", Some(&AGENT_LOGGING_DIR)));

    // Collect message IDs so we can assert on-chain delivery in the invariant check
    let message_ids: Vec<String> = (0..COMPOSITE_ISM_MESSAGES_EXPECTED)
        .map(|_| {
            initiate_hyperlane_transfer_to_sealeveltest2(
                solana_cli_tools_path.clone(),
                solana_config_path.clone(),
            )
            .join()
        })
        .collect();

    log!("Setup complete! Agents running in background...");

    let loop_start = Instant::now();
    sleep(Duration::from_secs(10));

    if !post_startup_invariants(&checkpoints_dirs) {
        panic!("Failure: Post startup invariants are not met");
    } else {
        log!("Success: Post startup invariants are met");
    }

    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            Ok(message_ids.iter().all(|id| {
                sealevel_client(&solana_cli_tools_path, &solana_config_path)
                    .cmd("mailbox")
                    .cmd("delivered")
                    .arg("message-id", id)
                    .arg("program-id", SEALEVELTEST2_MAILBOX_PROGRAM_ID)
                    .run_with_output()
                    .join()
                    .join("\n")
                    .contains("Message delivered")
            }))
        },
        || !SHUTDOWN.load(Ordering::Relaxed),
        || long_running_processes_exited_check(&mut state),
    );

    if !test_passed {
        panic!("Composite ISM e2e test failed");
    }
    log!("Composite ISM e2e test passed");
}

/// Deploy the composite ISM program to sealeveltest2, initialize it with a
/// mainnet-matching structure, and set it as the mailbox default ISM.
///
/// Root ISM: Aggregation(1, [Pausable, Routing])
/// Per-domain (sealeveltest1): Aggregation(1, [MultisigMessageId { validator, threshold=1 }])
///
/// Returns the deployed program ID.
fn deploy_and_configure_composite_ism(
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
    built_so_dir: &Path,
) -> String {
    // Root config mirrors mainnet defaultIsm: Aggregation(1, [Pausable, Routing])
    let root_config = serde_json::json!({
        "type": "aggregation",
        "threshold": 1,
        "sub_isms": [
            { "type": "pausable", "paused": false },
            { "type": "routing" }
        ]
    });

    // Per-domain ISM for sealeveltest1 origin: Aggregation(1, [MultisigMessageId])
    let domain_config = serde_json::json!({
        "type": "aggregation",
        "threshold": 1,
        "sub_isms": [
            {
                "type": "multisigMessageId",
                "validators": [SEALEVELTEST1_VALIDATOR_ECDSA_ADDR],
                "threshold": 1
            }
        ]
    });

    let mut root_config_file = NamedTempFile::new().expect("Failed to create temp root config");
    serde_json::to_writer(&mut root_config_file, &root_config)
        .expect("Failed to write root ISM config");

    let mut domain_config_file = NamedTempFile::new().expect("Failed to create temp domain config");
    serde_json::to_writer(&mut domain_config_file, &domain_config)
        .expect("Failed to write domain ISM config");

    // Write program-ids output to a temp directory to avoid polluting the source tree
    let envs_tempdir = tempdir().expect("Failed to create temp envs dir");

    sealevel_client(solana_cli_tools_path, solana_config_path)
        .arg("compute-budget", "200000")
        .cmd("composite-ism")
        .cmd("deploy")
        .arg("environment", SOLANA_ENV_NAME)
        .arg("environments-dir", envs_tempdir.path().to_str().unwrap())
        .arg("built-so-dir", built_so_dir.to_str().unwrap())
        .arg("chain", "sealeveltest2")
        .arg("local-domain", SEALEVELTEST2_DOMAIN_ID)
        .arg("config-file", root_config_file.path().to_str().unwrap())
        .run()
        .join();

    // Read the program ID written by the deploy command
    let program_ids_path = envs_tempdir
        .path()
        .join(SOLANA_ENV_NAME)
        .join("composite-ism")
        .join("sealeveltest2")
        .join("program-ids.json");
    let program_ids: serde_json::Value = serde_json::from_reader(
        File::open(&program_ids_path).expect("Failed to open program-ids.json"),
    )
    .expect("Failed to parse program-ids.json");
    let composite_ism_program_id = program_ids["program_id"]
        .as_str()
        .expect("program_id not found in program-ids.json")
        .to_string();

    log!(
        "Deployed composite ISM to sealeveltest2: {}",
        composite_ism_program_id
    );

    // Register the per-domain ISM for sealeveltest1
    sealevel_client(solana_cli_tools_path, solana_config_path)
        .arg("compute-budget", "200000")
        .cmd("composite-ism")
        .cmd("set-domain-ism")
        .arg("program-id", &composite_ism_program_id)
        .arg("domain", SEALEVELTEST1_DOMAIN_ID_U32.to_string())
        .arg("config-file", domain_config_file.path().to_str().unwrap())
        .run()
        .join();

    log!(
        "Registered per-domain ISM for origin {} on composite ISM {}",
        SEALEVELTEST1_DOMAIN_ID_U32,
        composite_ism_program_id
    );

    sealevel_client(solana_cli_tools_path, solana_config_path)
        .cmd("mailbox")
        .cmd("set-default-ism")
        .arg("program-id", SEALEVELTEST2_MAILBOX_PROGRAM_ID)
        .arg("default-ism", &composite_ism_program_id)
        .run()
        .join();

    log!("Set composite ISM as default ISM on sealeveltest2 mailbox");

    composite_ism_program_id
}

#[cfg(test)]
#[cfg(feature = "sealevel")]
mod test {
    #[test]
    fn test_run() {
        super::run_locally_composite_ism()
    }
}
