use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use macro_rules_attribute::apply;
use tempfile::{tempdir, tempfile, NamedTempFile, TempDir, TempPath};

use crate::config::{Config, ProgramArgs};
use crate::logging::log;
use crate::utils::{as_task, build_cmd, concat_path, run_agent, AgentHandles};
use crate::SOLANA_CLI_VERSION;

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
pub fn install_solana_cli_tools(config: Arc<Config>) -> PathBuf {
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
    build_cmd(
        ProgramArgs::new("curl")
            .arg("output", &solana_archive_name)
            .flag("location")
            .cmd(format!("https://github.com/solana-labs/solana/releases/download/v{SOLANA_CLI_VERSION}/{solana_archive_name}"))
            .flag("silent")
            .working_dir("target"),
        config.build_log_file.clone(), config.log_all, true
    )
        .join();
    log!("Uncompressing solana release");
    build_cmd(
        ProgramArgs::new("tar")
            .flag("extract")
            .arg("file", &solana_archive_name)
            .working_dir("target"),
        config.build_log_file.clone(),
        config.log_all,
        true,
    )
    .join();
    log!("Remove temporary solana files");
    fs::rename("target/solana-release", &solana_tools_dir)
        .expect("Failed to move solana-release dir");
    fs::remove_file(concat_path("target", &solana_archive_name))
        .expect("Failed to remove solana archive");
    concat_path(solana_tools_dir, "bin")
}

#[apply(as_task)]
pub fn clone_solana_program_library(config: Arc<Config>) -> PathBuf {
    let solana_programs_path = concat_path("target", "solana-program-library");
    if solana_programs_path.exists() {
        fs::remove_dir_all(&solana_programs_path).expect("Failed to remove solana program dir");
    }

    // get solana program library
    build_cmd(
        ProgramArgs::new("git")
            .cmd("clone")
            .arg("branch", SOLANA_PROGRAM_LIBRARY_REPO_BRANCH)
            .arg("depth", "1")
            .cmd(SOLANA_PROGRAM_LIBRARY_REPO)
            .cmd(solana_programs_path.to_str().unwrap()),
        config.build_log_file.clone(),
        config.log_all,
        true,
    )
    .join();

    solana_programs_path
}

#[apply(as_task)]
pub fn build_solana_programs(
    config: Arc<Config>,
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
    let build_sbf = ProgramArgs::new("cargo")
        .cmd("build-sbf")
        .env("PATH", updated_path(&solana_cli_tools_path))
        .env("SBF_OUT_PATH", out_path.to_str().unwrap());

    for &(path, _, _) in SOLANA_PROGRAMS {
        build_cmd(
            build_sbf
                .clone()
                .working_dir(concat_path(&solana_program_library_path, path)),
            config.build_log_file.clone(),
            config.log_all,
            true,
        )
        .join();
    }
    log!("All solana program library dependencies built successfully");
    fs::remove_dir_all(&solana_program_library_path).expect("Failed to remove solana program dir");

    // build our programs
    for &path in SOLANA_HYPERLANE_PROGRAMS {
        build_cmd(
            build_sbf
                .clone()
                .working_dir(concat_path("sealevel/programs", path)),
            config.build_log_file.clone(),
            config.log_all,
            true,
        )
        .join();
    }
    log!("All hyperlane solana programs built successfully");
    out_path
}

pub fn start_solana_test_validator(
    config: Arc<Config>,
    solana_cli_tools_path: &Path,
    solana_programs_path: &Path,
    ledger_dir: &Path,
) -> AgentHandles {
    let mut args = ProgramArgs::new(concat_path(solana_cli_tools_path, "solana-test-validator"))
        .flag("reset")
        .arg("ledger", ledger_dir.to_str().unwrap())
        .arg3(
            "account",
            "E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty",
            "config/sealevel/test-keys/test_deployer-account.json",
        );
    for &(_, address, lib) in SOLANA_PROGRAMS {
        args = args.arg3(
            "bpf-program",
            address,
            concat_path(solana_programs_path, lib).to_str().unwrap(),
        );
    }

    run_agent(args, "SOL", &config)
}

pub fn init_solana_config(config: &Config, solana_cli_tools_path: &Path) -> TempPath {
    let solana_config = NamedTempFile::new().unwrap().into_temp_path();

    build_cmd(
        ProgramArgs::new(concat_path(solana_cli_tools_path, "solana"))
            .arg("config", solana_config.to_str().unwrap())
            .cmd("config")
            .cmd("set")
            .arg("url", "localhost"),
        config.build_log_file.clone(),
        config.log_all,
        true,
    ).join();

    solana_config
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
