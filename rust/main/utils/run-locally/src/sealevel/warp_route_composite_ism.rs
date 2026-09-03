#![allow(dead_code)]

use std::{
    fs,
    fs::File,
    path::Path,
    str::FromStr,
    sync::atomic::Ordering,
    thread::sleep,
    time::{Duration, Instant},
};

use hyperlane_core::SubmitterType;
use hyperlane_sealevel_composite_ism::accounts::{derive_domain_pda, derive_process_authority};
use hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS;
use multisig_ism::domain_data_pda;
use solana_sdk::pubkey::Pubkey;
use tempfile::{tempdir, NamedTempFile};

use super::{RELAYER_KEYS, SEALEVEL_VALIDATOR_KEYS};
use crate::SHUTDOWN;
use crate::{
    config::Config,
    invariants::post_startup_invariants,
    logging::log,
    long_running_processes_exited_check,
    program::Program,
    sealevel::solana::{
        build_solana_programs, initiate_hyperlane_transfer_to_sealeveltest2,
        install_solana_cli_tools, parse_alt_address_from_json, sealevel_client,
        start_solana_test_validator, SEALEVELTEST2_DOMAIN_ID, SEALEVELTEST2_MAILBOX_PROGRAM_ID,
        SOLANA_CONTRACTS_CLI_RELEASE_URL, SOLANA_CONTRACTS_CLI_VERSION, SOLANA_ENV_NAME,
    },
    utils::{concat_path, get_sealevel_path, get_workspace_path, TaskHandle},
    wait_for_condition, State, AGENT_LOGGING_DIR, RELAYER_METRICS_PORT,
};

const MESSAGES_EXPECTED: u32 = 2;
const SUBMITTER_TYPE: SubmitterType = SubmitterType::Lander;
const SEALEVELTEST1_DOMAIN_ID: u32 = 13375;
const SEALEVELTEST2_FALLBACK_ISM: &str = "4RSV6iyqW9X66Xq3RDCVsKJ7hMba5uv6XP8ttgxjVUB1";
const SEALEVELTEST2_WARP_ROUTE: &str = "3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH";
const CHECKPOINT_LOCATION: &str =
    "/tmp/test_sealevel_warp_composite_checkpoints_0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

type DynPath = Box<dyn AsRef<Path>>;

fn run_locally_warp_route_composite_ism() {
    if let Err(error) = ctrlc::set_handler(|| {
        log!("Terminating...");
        SHUTDOWN.store(true, Ordering::Relaxed);
    }) {
        log!(
            "Failed to set ctrlc handler (may already be set): {:?}",
            error
        );
    }

    let config = Config::load();
    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    let checkpoint_path = Path::new(CHECKPOINT_LOCATION);
    fs::remove_dir_all(checkpoint_path).unwrap_or_default();
    let checkpoint_dirs: Vec<DynPath> = vec![Box::new(checkpoint_path) as DynPath];

    let rocks_db_dir = tempdir().expect("Failed to create tempdir for rocksdb");
    let relayer_db = concat_path(&rocks_db_dir, "relayer");
    let validator_db = concat_path(&rocks_db_dir, "validator0");

    let common_agent_env = Program::default()
        .env("RUST_BACKTRACE", "full")
        .hyp_env("LOG_FORMAT", "compact")
        .hyp_env("LOG_LEVEL", "debug");

    let base_relayer_env = common_agent_env
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
        .hyp_env("VALIDATOR_KEY", SEALEVEL_VALIDATOR_KEYS[0])
        .hyp_env("CHECKPOINTSYNCER_PATH", checkpoint_path.to_str().unwrap());

    let mut state = State::default();
    let solana_path_tempdir = tempdir().expect("Failed to create solana temp dir");
    let solana_cli_tools_path = install_solana_cli_tools(
        SOLANA_CONTRACTS_CLI_RELEASE_URL.to_owned(),
        SOLANA_CONTRACTS_CLI_VERSION.to_owned(),
        solana_path_tempdir.path().to_path_buf(),
    )
    .join();
    state.data.push(Box::new(solana_path_tempdir));

    let built_programs = build_solana_programs(solana_cli_tools_path.clone()).join();

    let build_main = Program::new("cargo")
        .cmd("build")
        .working_dir(&workspace_path)
        .arg("features", "test-utils")
        .arg("bin", "relayer")
        .arg("bin", "validator")
        .filter_logs(|line| !line.contains("workspace-inheritance"))
        .run();
    let build_client = Program::new("cargo")
        .working_dir(&sealevel_path)
        .cmd("build")
        .arg("bin", "hyperlane-sealevel-client")
        .filter_logs(|line| !line.contains("workspace-inheritance"))
        .run();
    build_main.join();
    build_client.join();

    let ledger_dir = tempdir().expect("Failed to create solana ledger dir");
    let validator_result = start_solana_test_validator(
        solana_cli_tools_path.clone(),
        built_programs.clone(),
        ledger_dir.as_ref().to_path_buf(),
    )
    .join();
    state.push_agent(validator_result.validator);
    let solana_config_path = validator_result.config_path;

    sleep(Duration::from_secs(10));

    let composite_ism = deploy_live_shaped_composite_ism(
        &solana_cli_tools_path,
        &solana_config_path,
        &built_programs,
    );
    set_warp_route_ism(&solana_cli_tools_path, &solana_config_path, &composite_ism);
    let route_alt = create_route_alt(&solana_cli_tools_path, &solana_config_path, &composite_ism);

    let process_alts = serde_json::to_string(&[validator_result.sealeveltest2_alt, route_alt])
        .expect("Failed to serialize process ALT config");
    let relayer_env =
        base_relayer_env.hyp_env("CHAINS_SEALEVELTEST2_MAILBOXPROCESSALTS", process_alts);

    state.push_agent(validator_env.spawn("VL1", Some(AGENT_LOGGING_DIR.as_ref())));
    state.push_agent(relayer_env.spawn("RLY", Some(&AGENT_LOGGING_DIR)));

    let message_ids: Vec<String> = (0..MESSAGES_EXPECTED)
        .map(|_| {
            initiate_hyperlane_transfer_to_sealeveltest2(
                solana_cli_tools_path.clone(),
                solana_config_path.clone(),
            )
            .join()
        })
        .collect();

    let loop_start = Instant::now();
    sleep(Duration::from_secs(10));
    assert!(
        post_startup_invariants(&checkpoint_dirs),
        "Post startup invariants are not met"
    );

    let test_passed = wait_for_condition(
        &config,
        loop_start,
        || {
            Ok(message_ids.iter().all(|message_id| {
                sealevel_client(&solana_cli_tools_path, &solana_config_path)
                    .cmd("mailbox")
                    .cmd("delivered")
                    .arg("message-id", message_id)
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

    assert!(test_passed, "Warp route composite ISM e2e test failed");
    log!("Warp route composite ISM e2e test passed");
}

/// Mirrors the custom ISM structure of the production route that exposed the
/// oversized mailbox process transaction.
fn deploy_live_shaped_composite_ism(
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
    built_so_dir: &Path,
) -> String {
    let warp_route_recipient = format!(
        "0x{}",
        hex::encode(
            Pubkey::from_str(SEALEVELTEST2_WARP_ROUTE)
                .expect("Invalid warp route program ID")
                .to_bytes()
        )
    );
    let config = serde_json::json!({
        "type": "aggregation",
        "threshold": 3,
        "sub_isms": [
            { "type": "pausable", "paused": false },
            {
                "type": "rateLimited",
                "max_capacity": 100_000_000_000_u64,
                "mailbox": SEALEVELTEST2_MAILBOX_PROGRAM_ID,
                "recipient": warp_route_recipient
            },
            {
                "type": "fallbackRouting",
                "fallback_ism": SEALEVELTEST2_FALLBACK_ISM
            }
        ]
    });
    let mut config_file = NamedTempFile::new().expect("Failed to create temp ISM config");
    serde_json::to_writer(&mut config_file, &config).expect("Failed to write ISM config");
    let environments_dir = tempdir().expect("Failed to create temp environments dir");

    sealevel_client(solana_cli_tools_path, solana_config_path)
        .arg("compute-budget", "200000")
        .cmd("composite-ism")
        .cmd("deploy")
        .arg("environment", SOLANA_ENV_NAME)
        .arg(
            "environments-dir",
            environments_dir.path().to_str().unwrap(),
        )
        .arg("built-so-dir", built_so_dir.to_str().unwrap())
        .arg("chain", "sealeveltest2")
        .arg("local-domain", SEALEVELTEST2_DOMAIN_ID)
        .arg("config-file", config_file.path().to_str().unwrap())
        .run()
        .join();

    let program_ids_path = environments_dir
        .path()
        .join(SOLANA_ENV_NAME)
        .join("composite-ism")
        .join("sealeveltest2")
        .join("program-ids.json");
    let program_ids: serde_json::Value = serde_json::from_reader(
        File::open(program_ids_path).expect("Failed to open program-ids.json"),
    )
    .expect("Failed to parse program-ids.json");
    program_ids["program_id"]
        .as_str()
        .expect("program_id not found in program-ids.json")
        .to_owned()
}

fn set_warp_route_ism(
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
    composite_ism: &str,
) {
    sealevel_client(solana_cli_tools_path, solana_config_path)
        .cmd("token")
        .cmd("set-interchain-security-module")
        .arg("program-id", SEALEVELTEST2_WARP_ROUTE)
        .arg("ism", composite_ism)
        .run()
        .join();
}

fn create_route_alt(
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
    composite_ism: &str,
) -> String {
    let mailbox = Pubkey::from_str(SEALEVELTEST2_MAILBOX_PROGRAM_ID).unwrap();
    let composite_ism = Pubkey::from_str(composite_ism).unwrap();
    let fallback_ism = Pubkey::from_str(SEALEVELTEST2_FALLBACK_ISM).unwrap();
    let warp_route = Pubkey::from_str(SEALEVELTEST2_WARP_ROUTE).unwrap();
    let (composite_vam, _) =
        Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &composite_ism);
    let (composite_domain, _) = derive_domain_pda(&composite_ism, SEALEVELTEST1_DOMAIN_ID);
    let (process_authority, _) = derive_process_authority(&mailbox, &composite_ism);
    let (fallback_vam, _) =
        Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &fallback_ism);
    let (fallback_domain, _) = domain_data_pda(&fallback_ism, SEALEVELTEST1_DOMAIN_ID);
    let (token_storage, _) = Pubkey::find_program_address(
        &[
            b"hyperlane_message_recipient",
            b"-",
            b"handle",
            b"-",
            b"account_metas",
        ],
        &warp_route,
    );
    let (dispatch_authority, _) = Pubkey::find_program_address(
        &[b"hyperlane_dispatcher", b"-", b"dispatch_authority"],
        &warp_route,
    );
    let (synthetic_mint, _) =
        Pubkey::find_program_address(&[b"hyperlane_token", b"-", b"mint"], &warp_route);
    let addresses = [
        warp_route,
        token_storage,
        dispatch_authority,
        synthetic_mint,
        composite_ism,
        composite_vam,
        composite_domain,
        process_authority,
        fallback_ism,
        fallback_vam,
        fallback_domain,
    ];

    let command = addresses.iter().fold(
        sealevel_client(solana_cli_tools_path, solana_config_path)
            .cmd("alt")
            .cmd("create")
            .arg("mailbox", SEALEVELTEST2_MAILBOX_PROGRAM_ID),
        |command, address| command.arg("additional-address", address.to_string()),
    );
    let output = command
        .arg("output-format", "json")
        .run_with_output()
        .join();
    parse_alt_address_from_json(&output)
        .unwrap_or_else(|| panic!("Failed to parse route ALT address: {output:?}"))
}

#[cfg(test)]
#[cfg(feature = "sealevel")]
mod test {
    #[test]
    fn test_warp_route_custom_composite_ism_process() {
        super::run_locally_warp_route_composite_ism()
    }
}
