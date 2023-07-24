use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use macro_rules_attribute::apply;

use crate::config::{Config, ProgramArgs};
use crate::logging::log;
use crate::utils::{as_task, build_cmd, concat_path};
use crate::SOLANA_CLI_VERSION;

// Install the CLI tools and return the path to the bin dir.
#[apply(as_task)]
pub fn install_solana_cli_tools(config: Arc<Config>) -> PathBuf {
    let solana_tools_dir = format!("target/solana-tools-{SOLANA_CLI_VERSION}");
    if Path::new(&solana_tools_dir).exists() {
        log!("Solana cli release v{} already downloaded", SOLANA_CLI_VERSION);
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
