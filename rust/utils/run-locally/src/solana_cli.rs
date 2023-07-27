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
// 0: Relative path to solana program source code within the solana program library repo.
// 1: Solana address or keypair for the bpf program
// 2: Name of the program's shared object file
const SOLANA_PROGRAMS: &[(&str, &str, &str)] = &[
    (
        "token/program",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "spl_token.so",
    ),
    (
        "token/program-2022",
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
        "spl_token_2022.so",
    ),
    (
        "associated-token-account/program",
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        "spl_associated_token_account.so",
    ),
    (
        "account-compression/programs/noop",
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

const SOLANA_PROGRAM_LIBRARY_REPO: &str =
    "https://github.com/hyperlane-xyz/solana-program-library.git";
const SOLANA_PROGRAM_LIBRARY_REPO_BRANCH: &str = "hyperlane";

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
pub fn clone_solana_program_library() -> PathBuf {
    let solana_programs_path = concat_path("target", "solana-program-library");
    if solana_programs_path.exists() {
        fs::remove_dir_all(&solana_programs_path).expect("Failed to remove solana program dir");
    }

    // get solana program library

    Program::new("git")
        .cmd("clone")
        .arg("branch", SOLANA_PROGRAM_LIBRARY_REPO_BRANCH)
        .arg("depth", "1")
        .cmd(SOLANA_PROGRAM_LIBRARY_REPO)
        .cmd(solana_programs_path.to_str().unwrap())
        .run()
        .join();

    solana_programs_path
}

#[apply(as_task)]
pub fn build_solana_programs(
    solana_cli_tools_path: PathBuf,
    solana_program_library_path: PathBuf,
) -> PathBuf {
    let out_path = Path::new(SBF_OUT_PATH);
    if out_path.exists() {
        fs::remove_dir_all(out_path).expect("Failed to remove solana program deploy dir");
    }
    fs::create_dir_all(out_path).expect("Failed to create solana program deploy dir");
    let out_path = out_path.canonicalize().unwrap();

    // build solana program library
    let build_sbf = Program::new("cargo")
        .cmd("build-sbf")
        .env("PATH", updated_path(&solana_cli_tools_path))
        .env("SBF_OUT_PATH", out_path.to_str().unwrap());

    for &(path, _, _) in SOLANA_PROGRAMS {
        build_sbf
            .clone()
            .working_dir(concat_path(&solana_program_library_path, path))
            .run()
            .join();
    }
    log!("All solana program library dependencies built successfully");
    fs::remove_dir_all(&solana_program_library_path).expect("Failed to remove solana program dir");

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
    for &(_, address, lib) in SOLANA_PROGRAMS {
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
        .arg("chain-id", "13375")
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
    let solana = Program::new(concat_path(&solana_cli_tools_path, "solana"))
        .arg("config", solana_config_path.to_str().unwrap())
        .arg("keypair", SOLANA_KEYPAIR);
    let sender = solana.cmd("adderss").run().join();
    // let sealevel_client = sealevel_client(&solana_cli_tools_path)
    //     .cmd("token")
    //     .cmd("transfer-remote")
    //     .cmd(SOLANA_KEYPAIR)
    //     .cmd("10000000000")
    //     .cmd("13376")
    //     .cmd(sender) // send to self
    //     .cmd("native")
    //     .arg("program-id", "CGn8yNtSD3aTTqJfYhUb6s1aVTN75NzwtsFKo1e83aga");

    todo!()
    // let sender_addr = solana.clone().cmd("address").join();
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
