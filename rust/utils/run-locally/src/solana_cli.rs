use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use macro_rules_attribute::apply;
use tempfile::{tempdir, NamedTempFile};

use crate::logging::log;
use crate::program::Program;
use crate::utils::{as_task, concat_path, AgentHandles, TaskHandle};
use crate::{AGENT_BIN_PATH, SOLANA_CLI_VERSION};

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
    (
        "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
        "spl_noop.so",
    ),
];

const SOLANA_KEYPAIR: &str = "config/sealevel/test-keys/test_deployer-keypair.json";

const SBF_OUT_PATH: &str = "target/deploy";

// Relative paths to solana program source code within rust/sealevel/programs repo.
const SOLANA_HYPERLANE_PROGRAMS: &[&str] = &[
    "mailbox",
    "validator-announce",
    "ism/multisig-ism-message-id",
    "hyperlane-sealevel-token",
    "hyperlane-sealevel-token-native",
    "hyperlane-sealevel-token-collateral",
];

const SOLANA_PROGRAM_LIBRARY_ARCHIVE: &str =
    "https://github.com/hyperlane-xyz/solana-program-library/releases/download/2023-07-27-01/spl.tar.gz";

// Install the CLI tools and return the path to the bin dir.
#[apply(as_task)]
pub fn install_solana_cli_tools() -> PathBuf {
    let solana_tools_dir = format!("target/solana-tools-{SOLANA_CLI_VERSION}");
    if Path::new(&solana_tools_dir).exists() {
        log!(
            "Solana cli release v{} already downloaded",
            SOLANA_CLI_VERSION
        );
        return concat_path(solana_tools_dir, "bin");
    }

    log!("Downloading solana cli release v{}", SOLANA_CLI_VERSION);
    let solana_release_name = {
        // best effort ot pick one of the supported targets
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
        .cmd(format!("https://github.com/solana-labs/solana/releases/download/v{SOLANA_CLI_VERSION}/{solana_archive_name}"))
        .flag("silent")
        .working_dir("target")
        .run()
        .join();
    log!("Uncompressing solana release");

    Program::new("tar")
        .flag("extract")
        .arg("file", &solana_archive_name)
        .working_dir("target")
        .run()
        .join();
    log!("Remove temporary solana files");
    fs::rename("target/solana-release", &solana_tools_dir)
        .expect("Failed to move solana-release dir");
    fs::remove_file(concat_path("target", &solana_archive_name))
        .expect("Failed to remove solana archive");
    concat_path(solana_tools_dir, "bin")
}

#[apply(as_task)]
pub fn build_solana_programs(
    solana_cli_tools_path: PathBuf,
) -> PathBuf {
    let out_path = Path::new(SBF_OUT_PATH);
    if out_path.exists() {
        fs::remove_dir_all(out_path).expect("Failed to remove solana program deploy dir");
    }
    fs::create_dir_all(out_path).expect("Failed to create solana program deploy dir");
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
    log!("Remove temporary solana files");
    fs::remove_file(concat_path(&out_path, "spl.tar.gz"))
        .expect("Failed to remove solana program archive");


    // build solana program library
    let build_sbf = Program::new("cargo")
        .cmd("build-sbf")
        .env("PATH", updated_path(&solana_cli_tools_path))
        .env("SBF_OUT_PATH", out_path.to_str().unwrap());

    // build our programs
    for &path in SOLANA_HYPERLANE_PROGRAMS {
        build_sbf
            .clone()
            .working_dir(concat_path("sealevel/programs", path))
            .run()
            .join();
    }
    log!("All hyperlane solana programs built successfully");
    out_path
}

#[apply(as_task)]
pub fn start_solana_test_validator(
    solana_cli_tools_path: PathBuf,
    solana_programs_path: PathBuf,
    ledger_dir: PathBuf,
) -> (PathBuf, AgentHandles) {
    // init solana config
    let solana_config = NamedTempFile::new().unwrap().into_temp_path();
    let solana_config_path = solana_config.to_path_buf();
    let solana_checkpoints = Arc::new(tempdir().unwrap());
    Program::new(concat_path(&solana_cli_tools_path, "solana"))
        .arg("config", solana_config.to_str().unwrap())
        .cmd("config")
        .cmd("set")
        .arg("url", "localhost")
        .run()
        .join();

    // run the validator
    let mut args = Program::new(concat_path(&solana_cli_tools_path, "solana-test-validator"))
        .flag("reset")
        .arg("ledger", ledger_dir.to_str().unwrap())
        .arg3(
            "account",
            "E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty",
            "config/sealevel/test-keys/test_deployer-account.json",
        )
        .remember(solana_config)
        .remember(solana_checkpoints.clone());
    for &(address, lib) in SOLANA_PROGRAMS {
        args = args.arg3(
            "bpf-program",
            address,
            concat_path(&solana_programs_path, lib).to_str().unwrap(),
        );
    }
    let validator = args.spawn("SOL");

    // deploy hyperlane programs
    let sealevel_client = sealevel_client(&solana_cli_tools_path);

    sealevel_client
        .clone()
        .cmd("multisig-ism-message-id")
        .cmd("set-validators-and-threshold")
        .arg("domain", "13375")
        .arg("validators", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8")
        .arg("threshold", "1")
        .arg("program-id", "4RSV6iyqW9X66Xq3RDCVsKJ7hMba5uv6XP8ttgxjVUB1")
        .run()
        .join();

    sealevel_client
            .clone()
            .cmd("validator-announce")
            .cmd("announce")
            .arg("validator", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8")
            .arg(
                "storage-location",
                format!("file://{}", solana_checkpoints.path().to_str().unwrap()),
            )
            .arg("signature", "0xcd87b715cd4c2e3448be9e34204cf16376a6ba6106e147a4965e26ea946dd2ab19598140bf26f1e9e599c23f6b661553c7d89e8db22b3609068c91eb7f0fa2f01b")
            .run()
    .join();

    sealevel_client
        .arg("compute-budget", "200000")
        .cmd("warp-route")
        .cmd("deploy")
        .arg("warp-route-name", "testwarproute")
        .arg("environment", "local-e2e")
        .arg("environments-dir", "sealevel/environments")
        .arg("built-so-dir", SBF_OUT_PATH)
        .arg(
            "token-config-file",
            "sealevel/environments/local-e2e/warp-routes/testwarproute/token-config.json",
        )
        .arg(
            "chain-config-file",
            "sealevel/environments/local-e2e/warp-routes/chain-config.json",
        )
        .arg("ata-payer-funding-amount", "1000000000")
        .run()
        .join();

    (solana_config_path, validator)
}

#[apply(as_task)]
pub fn initiate_solana_hyperlane_transfer(
    solana_cli_tools_path: PathBuf,
    solana_config_path: PathBuf,
) {
    let sender = Program::new(concat_path(&solana_cli_tools_path, "solana"))
        .arg("config", solana_config_path.to_str().unwrap())
        .arg("keypair", SOLANA_KEYPAIR)
        .cmd("adderss")
        .run_with_output()
        .join()
        .get(0)
        .expect("failed to get sender address")
        .trim()
        .to_owned();

    sealevel_client(&solana_cli_tools_path)
        .cmd("token")
        .cmd("transfer-remote")
        .cmd(SOLANA_KEYPAIR)
        .cmd("10000000000")
        .cmd("13376")
        .cmd(sender) // send to self
        .cmd("native")
        .arg("program-id", "CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga");
}

pub fn solana_termination_invariants_met(solana_cli_tools_path: PathBuf) -> bool {
    sealevel_client(&solana_cli_tools_path)
        .cmd("mailbox")
        .cmd("delivered")
        .arg(
            "message-id",
            "0x7b8ba684e5ce44f898c5fa81785c83a00e32b5bef3412e648eb7a17bec497685",
        )
        .arg("program-id", "9tCUWNjpqcf3NUSrtp7vquYVCwbEByvLjZUrhG5dgvhj")
        .run_with_output()
        .join()
        .join("\n")
        .contains("Message delivered")
}

fn sealevel_client(solana_cli_tools_path: &Path) -> Program {
    Program::new(concat_path(AGENT_BIN_PATH, "hyperlane-sealevel-client"))
        .env("PATH", updated_path(&solana_cli_tools_path))
        .arg("keypair", SOLANA_KEYPAIR)
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
