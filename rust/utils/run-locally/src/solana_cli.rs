use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use macro_rules_attribute::apply;

use crate::config::{Config, ProgramArgs};
use crate::logging::log;
use crate::utils::{as_task, build_cmd, concat_path};
use crate::SOLANA_CLI_VERSION;

// Relative paths to solana program source code within the solana program library repo.
const SOLANA_PROGRAMS: &[&str] = &[
    "token/program",
    "token/program-2022",
    "associated-token-account/program",
    "account-compression/programs/noop",
];

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
pub fn build_solana_program_library(config: Arc<Config>, solana_cli_tools_path: PathBuf) {
    let solana_programs_path = concat_path("target", "solana-program-library");
    let target_path = Path::new("target").canonicalize().unwrap();
    let out_path = concat_path(target_path, "solana-program-library-deploy");

    if solana_programs_path.exists() {
        fs::remove_dir_all(&solana_programs_path).expect("Failed to remove solana program dir");
    }
    if out_path.exists() {
        fs::remove_dir_all(&out_path).expect("Failed to remove solana program deploy dir");
    }

    build_cmd(
        ProgramArgs::new("git")
            .cmd("clone")
            .arg("branch", "hyperlane")
            .arg("depth", "1")
            .cmd("https://github.com/hyperlane-xyz/solana-program-library.git")
            .cmd(solana_programs_path.to_str().unwrap()),
        config.build_log_file.clone(),
        config.log_all,
        true,
    )
    .join();

    let path = format!(
        "{}:{}",
        std::env::var("PATH").unwrap_or_default(),
        solana_cli_tools_path
            .canonicalize()
            .expect("Failed to canonicalize solana cli tools path")
            .to_str()
            .unwrap()
    );

    let cmd = ProgramArgs::new("cargo")
        .cmd("build-sbf")
        .env("PATH", path)
        .env("SBF_OUT_PATH", out_path.to_str().unwrap())
        .raw_arg("--"); // pass remaining to `cargo build` directly
    for &path in SOLANA_PROGRAMS {
        build_cmd(
            cmd.clone()
                .working_dir(concat_path(&solana_programs_path, path)),
            config.build_log_file.clone(),
            config.log_all,
            true,
        )
        .join();
    }
    fs::remove_dir_all(&solana_programs_path).expect("Failed to remove solana program dir");
}
