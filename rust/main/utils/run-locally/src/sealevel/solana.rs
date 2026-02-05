#![allow(dead_code)]
use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::Duration;

use macro_rules_attribute::apply;
use regex::Regex;
use serde::Deserialize;
use tempfile::{tempdir, NamedTempFile};

use crate::logging::log;
use crate::program::Program;
use crate::utils::{
    as_task, concat_path, get_sealevel_path, get_workspace_path, AgentHandles, TaskHandle,
};

pub const SOLANA_AGENT_BIN_PATH: &str = "target/debug";

/// Solana CLI version for compiling programs
pub const SOLANA_CONTRACTS_CLI_VERSION: &str = "1.14.20";
pub const SOLANA_CONTRACTS_CLI_RELEASE_URL: &str = "github.com/solana-labs/solana";

/// Solana version used by mainnet validators
pub const SOLANA_NETWORK_CLI_VERSION: &str = "2.0.24";
pub const SOLANA_NETWORK_CLI_RELEASE_URL: &str = "github.com/anza-xyz/agave";

const SOLANA_PROGRAM_LIBRARY_ARCHIVE: &str =
    "https://github.com/hyperlane-xyz/solana-program-library/releases/download/2024-08-23/spl.tar.gz";

// Solana program tuples of:
// 0: Solana address or keypair for the bpf program
// 1: Name of the program's shared object file
const SOLANA_PROGRAMS: &[(&str, &str)] = &[
    (
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "spl_token.so",
    ),
    (
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "spl_token_2022.so",
    ),
    (
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "spl_associated_token_account.so",
    ),
    ("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV", "spl_noop.so"),
];

// Relative paths to solana program source code within rust/sealevel/programs repo.
const SOLANA_HYPERLANE_PROGRAMS: &[&str] = &[
    "mailbox",
    "validator-announce",
    "ism/multisig-ism-message-id",
    "hyperlane-sealevel-token",
    "hyperlane-sealevel-token-native",
    "hyperlane-sealevel-token-collateral",
    "hyperlane-sealevel-igp",
];

// Used for deploying programs & running the relayer
const SOLANA_DEPLOYER_KEYPAIR: &str = "environments/local-e2e/accounts/test_deployer-keypair.json";
const SOLANA_DEPLOYER_ACCOUNT: &str = "environments/local-e2e/accounts/test_deployer-account.json";

const LOCAL_E2E_MOCK_REGISTRY: &str = "environments/local-e2e/mock-registry";

const SOLANA_WARPROUTE_TOKEN_CONFIG_FILE: &str =
    "environments/local-e2e/warp-routes/testwarproute/token-config.json";
const SOLANA_ENVS_DIR: &str = "environments";

const SOLANA_ENV_NAME: &str = "local-e2e";

const SBF_OUT_PATH: &str = "target/dist";

// Domain IDs for sealevel test chains
const SEALEVELTEST1_DOMAIN_ID: &str = "13375";
const SEALEVELTEST2_DOMAIN_ID: &str = "13376";
const SEALEVELTEST3_DOMAIN_ID: &str = "13377";

const SEALEVELTEST1_IGP_PROGRAM_ID: &str = "GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U";
const SEALEVELTEST2_IGP_PROGRAM_ID: &str = "FArd4tEikwz2fk3MB7S9kC82NGhkgT6f9aXi3C5cw1E5";
const SEALEVELTEST3_IGP_PROGRAM_ID: &str = "Bimih5j2Vbw1ytUbLW3uQPfykHzPdDZrevSz6ZSYNAvf";
const SEALEVELTEST3_MULTISIG_ISM_PROGRAM_ID: &str = "ECEnBkaZVaDnCpLN836tpdXYHhifXsB8QZpcGk4FNCk5";

// Sealeveltest2 mailbox program ID (used for ALT creation on destination)
// ALT must be for the destination chain since it's used when DELIVERING messages
const SEALEVELTEST2_MAILBOX_PROGRAM_ID: &str = "9tCUWNjpqcf3NUSrtp7vquYVCwbEByvLjZUrhG5dgvhj";

// Warp route program ID for sealeveltest1
const SEALEVELTEST1_WARP_ROUTE_PROGRAM_ID: &str = "CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga";

// Send to a random account, because for safety reasons we don't allow the
// relayer to relay a message that includes the relayer's payer account in its list of accounts.
const TRANSFER_RECIPIENT: &str = "FeSKs7MbwF86PVuofzhKmzWVVFjyVtBTYXJZqQkBYzB6";

// TODO: use a temp dir instead!
pub const SOLANA_CHECKPOINT_LOCATION: &str =
    "/tmp/test_sealevel_checkpoints_0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
pub const SOLANA_CHECKPOINT_LOCATION_2: &str =
    "/tmp/test_sealevel_checkpoints_2_0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

const SOLANA_GAS_ORACLE_CONFIG_FILE: &str = "environments/local-e2e/gas-oracle-configs.json";

// Install the CLI tools and return the path to the bin dir.
#[apply(as_task)]
pub fn install_solana_cli_tools(
    release_url: String,
    release_version: String,
    tools_dir: PathBuf,
) -> PathBuf {
    let solana_download_dir = tempdir().unwrap();
    log!(
        "Downloading solana cli release v{} from {}",
        release_version,
        release_url
    );
    let solana_release_name = {
        // best effort to pick one of the supported targets
        let target = if cfg!(target_os = "linux") {
            "x86_64-unknown-linux-gnu"
        } else if cfg!(target_os = "macos") {
            if cfg!(target_arch = "aarch64") {
                "aarch64-apple-darwin"
            } else {
                "x86_64-apple-darwin"
            }
        } else if cfg!(target_os = "windows") {
            "pc-windows-msvc"
        } else {
            panic!("Current os is not supported by solana")
        };
        format!("solana-release-{target}")
    };
    let solana_archive_name = format!("{solana_release_name}.tar.bz2");

    Program::new("curl")
        .arg("output", &solana_archive_name)
        .flag("location")
        .cmd(format!(
            "https://{release_url}/releases/download/v{release_version}/{solana_archive_name}"
        ))
        .flag("silent")
        .working_dir(solana_download_dir.as_ref().to_str().unwrap())
        .run()
        .join();
    log!("Uncompressing solana release");

    Program::new("tar")
        .flag("extract")
        .arg("file", &solana_archive_name)
        .working_dir(solana_download_dir.as_ref().to_str().unwrap())
        .run()
        .join();

    fs::rename(
        concat_path(&solana_download_dir, "solana-release"),
        &tools_dir,
    )
    .expect("Failed to move solana-release dir");
    concat_path(&tools_dir, "bin")
}

#[apply(as_task)]
pub fn build_solana_programs(solana_cli_tools_path: PathBuf) -> PathBuf {
    let workspace_path = get_workspace_path();
    let out_path = concat_path(&workspace_path, SBF_OUT_PATH);
    if out_path.exists() {
        fs::remove_dir_all(&out_path).expect("Failed to remove solana program deploy dir");
    }
    fs::create_dir_all(&out_path).expect("Failed to create solana program deploy dir");
    let out_path = out_path.canonicalize().unwrap();

    Program::new("curl")
        .arg("output", "spl.tar.gz")
        .flag("location")
        .cmd(SOLANA_PROGRAM_LIBRARY_ARCHIVE)
        .flag("silent")
        .working_dir(&out_path)
        .run()
        .join();
    log!("Uncompressing solana programs");

    Program::new("tar")
        .flag("extract")
        .arg("file", "spl.tar.gz")
        .working_dir(&out_path)
        .run()
        .join();
    log!("Removing temporary solana files");
    fs::remove_file(concat_path(&out_path, "spl.tar.gz"))
        .expect("Failed to remove solana program archive");

    let bin_path = concat_path(&solana_cli_tools_path, "cargo-build-sbf");
    let build_sbf = Program::new(bin_path).env("SBF_OUT_PATH", out_path.to_str().unwrap());

    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);
    let sealevel_programs = concat_path(sealevel_path, "programs");

    // build our programs
    for &path in SOLANA_HYPERLANE_PROGRAMS {
        build_sbf
            .clone()
            .working_dir(concat_path(&sealevel_programs, path))
            .run()
            .join();
    }
    log!("All hyperlane solana programs built successfully");
    out_path
}

/// Result from starting the solana test validator
pub struct SolanaTestValidatorResult {
    pub config_path: PathBuf,
    pub validator: AgentHandles,
    /// ALT address for sealeveltest2 (for versioned transactions on destination)
    pub sealeveltest2_alt: String,
}

#[apply(as_task)]
pub fn start_solana_test_validator(
    solana_cli_tools_path: PathBuf,
    solana_programs_path: PathBuf,
    ledger_dir: PathBuf,
) -> SolanaTestValidatorResult {
    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    let solana_deployer_account = concat_path(&sealevel_path, SOLANA_DEPLOYER_ACCOUNT);
    let solana_deployer_account_str = solana_deployer_account.to_string_lossy();

    let solana_env_dir = concat_path(&sealevel_path, SOLANA_ENVS_DIR);
    let solana_env_dir_str = solana_env_dir.to_string_lossy();

    let _mock_registry_path = concat_path(&sealevel_path, LOCAL_E2E_MOCK_REGISTRY);

    let solana_warproute_token_config_file =
        concat_path(&sealevel_path, SOLANA_WARPROUTE_TOKEN_CONFIG_FILE);
    let solana_warproute_token_config_file_str =
        solana_warproute_token_config_file.to_string_lossy();

    let solana_gas_oracle_config_file = concat_path(&sealevel_path, SOLANA_GAS_ORACLE_CONFIG_FILE);
    let solana_gas_oracle_config_file_str = solana_gas_oracle_config_file.to_string_lossy();

    let build_so_dir = concat_path(&workspace_path, SBF_OUT_PATH);
    let build_so_dir_str = build_so_dir.to_string_lossy();
    // init solana config
    let solana_config = NamedTempFile::new().unwrap().into_temp_path();
    let solana_config_path = solana_config.to_path_buf();

    Program::new(concat_path(&solana_cli_tools_path, "solana"))
        .arg("config", solana_config_path.to_string_lossy())
        .cmd("config")
        .cmd("set")
        .arg("url", "localhost")
        .run()
        .join();

    log!("Starting solana validator");
    let mut args = Program::new(concat_path(&solana_cli_tools_path, "solana-test-validator"))
        .flag("quiet")
        .flag("reset")
        .arg("ledger", ledger_dir.to_str().unwrap())
        .arg3(
            "account",
            "E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty",
            solana_deployer_account_str.clone(),
        )
        .remember(solana_config);
    for &(address, lib) in SOLANA_PROGRAMS {
        args = args.arg3(
            "bpf-program",
            address,
            concat_path(&solana_programs_path, lib).to_str().unwrap(),
        );
    }
    let validator = args.spawn("SOL", None);
    sleep(Duration::from_secs(5));

    log!("Deploying the hyperlane programs to solana");

    let sealevel_client = sealevel_client(&solana_cli_tools_path, &solana_config_path);
    let sealevel_client_deploy_core = sealevel_client
        .clone()
        .arg("compute-budget", "200000")
        .cmd("core")
        .cmd("deploy")
        .arg("environment", SOLANA_ENV_NAME)
        .arg("environments-dir", solana_env_dir_str.clone())
        .arg("built-so-dir", build_so_dir_str.clone());

    // Deploy sealeveltest1 core
    sealevel_client_deploy_core
        .clone()
        .arg("local-domain", SEALEVELTEST1_DOMAIN_ID)
        .arg("chain", "sealeveltest1")
        .run()
        .join();

    // Deploy sealeveltest2 core
    sealevel_client_deploy_core
        .clone()
        .arg("local-domain", SEALEVELTEST2_DOMAIN_ID)
        .arg("chain", "sealeveltest2")
        .run()
        .join();

    // Deploy sealeveltest3 core (NO ALT - will use legacy transactions)
    sealevel_client_deploy_core
        .arg("local-domain", SEALEVELTEST3_DOMAIN_ID)
        .arg("chain", "sealeveltest3")
        .run()
        .join();

    let igp_configure_command = sealevel_client
        .clone()
        .cmd("igp")
        .cmd("configure")
        .arg(
            "gas-oracle-config-file",
            solana_gas_oracle_config_file_str.clone(),
        )
        .arg("registry", LOCAL_E2E_MOCK_REGISTRY);

    // Configure sealeveltest1 IGP
    igp_configure_command
        .clone()
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("chain", "sealeveltest1")
        .run()
        .join();

    // Configure sealeveltest2 IGP
    igp_configure_command
        .clone()
        .arg("program-id", SEALEVELTEST2_IGP_PROGRAM_ID)
        .arg("chain", "sealeveltest2")
        .run()
        .join();

    // Configure sealeveltest3 IGP
    igp_configure_command
        .arg("program-id", SEALEVELTEST3_IGP_PROGRAM_ID)
        .arg("chain", "sealeveltest3")
        .run()
        .join();

    sealevel_client
        .clone()
        .arg("compute-budget", "200000")
        .cmd("warp-route")
        .cmd("deploy")
        .arg("environment", SOLANA_ENV_NAME)
        .arg("environments-dir", solana_env_dir_str.clone())
        .arg("built-so-dir", build_so_dir_str.clone())
        .arg("warp-route-name", "testwarproute")
        .arg(
            "token-config-file",
            solana_warproute_token_config_file_str.clone(),
        )
        .arg("registry", LOCAL_E2E_MOCK_REGISTRY)
        .arg("ata-payer-funding-amount", "1000000000")
        .run()
        .join();

    log!("Initializing solana programs");
    // Configure sealeveltest2's ISM to accept sealeveltest1's validator
    sealevel_client
        .clone()
        .cmd("multisig-ism-message-id")
        .cmd("set-validators-and-threshold")
        .arg("domain", SEALEVELTEST1_DOMAIN_ID)
        .arg("validators", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8")
        .arg("threshold", "1")
        .arg("program-id", "4RSV6iyqW9X66Xq3RDCVsKJ7hMba5uv6XP8ttgxjVUB1")
        .run()
        .join();

    // Configure sealeveltest3's ISM to accept sealeveltest1's validator
    sealevel_client
        .clone()
        .cmd("multisig-ism-message-id")
        .cmd("set-validators-and-threshold")
        .arg("domain", SEALEVELTEST1_DOMAIN_ID)
        .arg("validators", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8")
        .arg("threshold", "1")
        .arg("program-id", SEALEVELTEST3_MULTISIG_ISM_PROGRAM_ID)
        .run()
        .join();

    // So we can test paying for gas with a different IGP account
    const ALTERNATIVE_SALT: &str =
        "0x0000000000000000000000000000000000000000000000000000000000000001";
    const ALTERNATIVE_IGP_ACCOUNT: &str = "8EniU8dQaGQ3HWWtT77V7hrksheygvEu6TtzJ3pX1nKM";

    sealevel_client
        .clone()
        .cmd("igp")
        .cmd("init-igp-account")
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("environment", SOLANA_ENV_NAME)
        .arg("environments-dir", solana_env_dir_str)
        .arg("chain", "sealeveltest1")
        .arg("account-salt", ALTERNATIVE_SALT)
        .run()
        .join();

    sealevel_client
        .clone()
        .cmd("igp")
        .cmd("init-overhead-igp-account")
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("environment", SOLANA_ENV_NAME)
        .arg("environments-dir", SOLANA_ENVS_DIR)
        .arg("chain", "sealeveltest1")
        .arg("inner-igp-account", ALTERNATIVE_IGP_ACCOUNT)
        .arg("account-salt", ALTERNATIVE_SALT)
        .run()
        .join();

    sealevel_client
        .clone()
        .cmd("igp")
        .cmd("configure")
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("gas-oracle-config-file", solana_gas_oracle_config_file_str)
        .arg("registry", LOCAL_E2E_MOCK_REGISTRY)
        .arg("chain", "sealeveltest1")
        .arg("account-salt", ALTERNATIVE_SALT)
        .run()
        .join();

    // Create ALT for sealeveltest2 (destination chain) to test versioned transactions
    // ALT is used when DELIVERING messages, so it must be configured on the destination
    // Messages go: sealeveltest1 -> sealeveltest2, so ALT is needed for sealeveltest2
    log!("Creating Address Lookup Table (ALT) for sealeveltest2 (destination)...");
    let alt_output = sealevel_client
        .cmd("alt")
        .cmd("create")
        .arg("mailbox", SEALEVELTEST2_MAILBOX_PROGRAM_ID)
        .arg("output-format", "json")
        .run_with_output()
        .join();

    let sealeveltest2_alt = parse_alt_address_from_json(&alt_output)
        .unwrap_or_else(|| panic!("Failed to parse ALT address from output: {alt_output:?}"));
    log!("Created ALT for sealeveltest2: {}", sealeveltest2_alt);

    log!("Local Solana chain started and hyperlane programs deployed and initialized successfully");

    SolanaTestValidatorResult {
        config_path: solana_config_path,
        validator,
        sealeveltest2_alt,
    }
}

#[derive(Deserialize)]
struct AltCreateOutput {
    address: String,
}

/// Parse ALT address from JSON output: {"address":"<pubkey>"}
fn parse_alt_address_from_json(output: &[String]) -> Option<String> {
    for line in output {
        if let Ok(parsed) = serde_json::from_str::<AltCreateOutput>(line) {
            return Some(parsed.address);
        }
    }
    None
}

/// Initiate a transfer from sealeveltest1 to sealeveltest2 (versioned tx with ALT on destination)
#[apply(as_task)]
#[allow(clippy::get_first)] // TODO: `rustc` 1.80.1 clippy issue
pub fn initiate_hyperlane_transfer_to_sealeveltest2(
    solana_cli_tools_path: PathBuf,
    solana_config_path: PathBuf,
) -> String {
    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    let solana_keypair = concat_path(sealevel_path, SOLANA_DEPLOYER_KEYPAIR);
    let solana_keypair_str = solana_keypair.to_string_lossy();

    let output = sealevel_client(&solana_cli_tools_path, &solana_config_path)
        .cmd("token")
        .cmd("transfer-remote")
        .cmd(solana_keypair_str.clone())
        .cmd("10000000000")
        .cmd(SEALEVELTEST2_DOMAIN_ID)
        .cmd(TRANSFER_RECIPIENT)
        .cmd("native")
        .arg("program-id", SEALEVELTEST1_WARP_ROUTE_PROGRAM_ID)
        .run_with_output()
        .join();

    let message_id = get_message_id_from_logs(output.clone())
        .unwrap_or_else(|| panic!("failed to get message id from logs for transfer: {output:?}"));

    log!("Transfer to sealeveltest2, message id: {}", message_id);
    sealevel_client(&solana_cli_tools_path, &solana_config_path)
        .cmd("igp")
        .cmd("pay-for-gas")
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("message-id", message_id.clone())
        .arg("destination-domain", SEALEVELTEST2_DOMAIN_ID)
        .arg("gas", "100000")
        .run()
        .join();
    message_id
}

/// Initiate a transfer from sealeveltest1 to sealeveltest3 (legacy tx, NO ALT on destination)
#[apply(as_task)]
#[allow(clippy::get_first)]
pub fn initiate_hyperlane_transfer_to_sealeveltest3(
    solana_cli_tools_path: PathBuf,
    solana_config_path: PathBuf,
) -> String {
    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    let solana_keypair = concat_path(sealevel_path, SOLANA_DEPLOYER_KEYPAIR);
    let solana_keypair_str = solana_keypair.to_string_lossy();

    let output = sealevel_client(&solana_cli_tools_path, &solana_config_path)
        .cmd("token")
        .cmd("transfer-remote")
        .cmd(solana_keypair_str.clone())
        .cmd("10000000000")
        .cmd(SEALEVELTEST3_DOMAIN_ID)
        .cmd(TRANSFER_RECIPIENT)
        .cmd("native")
        .arg("program-id", SEALEVELTEST1_WARP_ROUTE_PROGRAM_ID)
        .run_with_output()
        .join();

    let message_id = get_message_id_from_logs(output.clone())
        .unwrap_or_else(|| panic!("failed to get message id from logs for transfer: {output:?}"));

    log!(
        "Transfer to sealeveltest3 (legacy tx), message id: {}",
        message_id
    );
    sealevel_client(&solana_cli_tools_path, &solana_config_path)
        .cmd("igp")
        .cmd("pay-for-gas")
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("message-id", message_id.clone())
        .arg("destination-domain", SEALEVELTEST3_DOMAIN_ID)
        .arg("gas", "100000")
        .run()
        .join();
    message_id
}

#[apply(as_task)]
#[allow(clippy::get_first)]
pub fn initiate_non_matching_igp_paying_transfer(
    solana_cli_tools_path: PathBuf,
    solana_config_path: PathBuf,
) -> String {
    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    let solana_keypair = concat_path(sealevel_path, SOLANA_DEPLOYER_KEYPAIR);
    let solana_keypair_str = solana_keypair.to_string_lossy();

    let output = sealevel_client(&solana_cli_tools_path, &solana_config_path)
        .cmd("token")
        .cmd("transfer-remote")
        .cmd(solana_keypair_str)
        .cmd("10000000000")
        .cmd(SEALEVELTEST2_DOMAIN_ID)
        .cmd(TRANSFER_RECIPIENT)
        .cmd("native")
        .arg("program-id", SEALEVELTEST1_WARP_ROUTE_PROGRAM_ID)
        .run_with_output()
        .join();
    let non_matching_igp_message_id =
        get_message_id_from_logs(output.clone()).unwrap_or_else(|| {
            panic!(
                "failed to get message id from logs non-matching igp paying transfer: {output:?}"
            )
        });

    log!(
        "paying gas to a different IGP account for message id: {}",
        non_matching_igp_message_id
    );
    sealevel_client(&solana_cli_tools_path, &solana_config_path)
        .cmd("igp")
        .cmd("pay-for-gas")
        .arg("program-id", SEALEVELTEST1_IGP_PROGRAM_ID)
        .arg("message-id", non_matching_igp_message_id.clone())
        .arg("destination-domain", SEALEVELTEST2_DOMAIN_ID)
        .arg("gas", "100000")
        .arg(
            "account-salt",
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        )
        .run()
        .join();
    non_matching_igp_message_id
}

fn get_message_id_from_logs(logs: Vec<String>) -> Option<String> {
    let message_id_regex = Regex::new(r"Dispatched message to \d+, ID 0x([0-9a-fA-F]+)").unwrap();
    for log in logs {
        // Use the regular expression to capture the ID
        if let Some(captures) = message_id_regex.captures(&log) {
            if let Some(id_match) = captures.get(1) {
                let id = id_match.as_str();
                return Some(format!("0x{id}"));
            }
        }
    }
    None
}

pub fn solana_termination_invariants_met(
    solana_cli_tools_path: &Path,
    solana_config_path: &Path,
) -> bool {
    sealevel_client(solana_cli_tools_path, solana_config_path)
        .cmd("mailbox")
        .cmd("delivered")
        .arg(
            // this will break if any parts of `transfer-remote` change.
            // This value was gotten by observing the relayer logs.
            // TODO: get the actual message-id so we don't have to hardcode it
            "message-id",
            "0xe73469a5e7c5a73f7afa1f2e4c8bfff42d1f3c462c8df2ac8aa328c2264044fc",
        )
        .arg("program-id", "9tCUWNjpqcf3NUSrtp7vquYVCwbEByvLjZUrhG5dgvhj")
        .run_with_output()
        .join()
        .join("\n")
        .contains("Message delivered")
}
fn sealevel_client(solana_cli_tools_path: &Path, solana_config_path: &Path) -> Program {
    let workspace_path = get_workspace_path();
    let sealevel_path = get_sealevel_path(&workspace_path);

    let solana_keypair = concat_path(&sealevel_path, SOLANA_DEPLOYER_KEYPAIR);
    let solana_keypair_str = solana_keypair.to_string_lossy();

    Program::new(concat_path(
        &sealevel_path,
        format!("{SOLANA_AGENT_BIN_PATH}/hyperlane-sealevel-client"),
    ))
    .working_dir(sealevel_path.clone())
    .env("PATH", updated_path(solana_cli_tools_path))
    .env("RUST_BACKTRACE", "1")
    .arg("config", solana_config_path.to_str().unwrap())
    .arg("keypair", solana_keypair_str)
}

fn updated_path(solana_cli_tools_path: &Path) -> String {
    format!(
        "{}:{}",
        solana_cli_tools_path
            .canonicalize()
            .expect("Failed to canonicalize solana cli tools path")
            .to_str()
            .unwrap(),
        std::env::var("PATH").unwrap_or_default(),
    )
}
