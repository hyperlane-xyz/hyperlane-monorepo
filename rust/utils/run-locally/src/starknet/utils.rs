use macro_rules_attribute::apply;
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::program::Program;
use crate::utils::{as_task, TaskHandle};

use super::cli::StarknetCLI;
use super::types::{DeclaredClasses, Deployments};

pub(crate) const STARKNET_KEYPAIR: &str = "./config/test-starknet-keys/test_deployer-keypair.json";
pub(crate) const STARKNET_ACCOUNT: &str = "./config/test-starknet-keys/test_deployer-account.json";
pub(crate) const KEYPAIR_PASSWORD: &str = "test";

pub(crate) fn untar(output: &str, dir: &str) {
    Program::new("tar")
        .flag("extract")
        .arg("file", output)
        .working_dir(dir)
        .run()
        .join();
}

pub(crate) fn unzip(output: &str, dir: &str) {
    Program::new("unzip")
        .cmd(output)
        .working_dir(dir)
        .run()
        .join();
}

pub(crate) fn download(output: &str, uri: &str, dir: &str) {
    Program::new("curl")
        .arg("output", output)
        .flag("location")
        .cmd(uri)
        .flag("silent")
        .working_dir(dir)
        .run()
        .join();
}

pub(crate) fn make_target() -> String {
    let os = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        panic!("Current os is not supported by Katana")
    };

    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };

    format!("{}_{}", os, arch)
}

pub(crate) fn make_target_starkli() -> String {
    let os = if cfg!(target_os = "linux") {
        "linux-android"
    } else if cfg!(target_os = "macos") {
        "apple-darwin"
    } else {
        panic!("Current os is not supported by Katana")
    };

    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };

    format!("{}-{}", arch, os)
}

#[apply(as_task)]
pub(crate) fn declare_all(
    cli: StarknetCLI,
    sierra_classes: BTreeMap<String, PathBuf>,
) -> DeclaredClasses {
    for (_class, path) in sierra_classes {
        let declare_result = cli.declare(path);

        println!("declare result: {:?}", declare_result);
    }

    DeclaredClasses {
        hpl_hook_merkle: "".to_string(),
        hpl_hook_routing: "".to_string(),
        hpl_igp: "".to_string(),
        hpl_igp_oracle: "".to_string(),
        hpl_ism_aggregate: "".to_string(),
        hpl_ism_multisig: "".to_string(),
        hpl_ism_pausable: "".to_string(),
        hpl_ism_routing: "".to_string(),
        hpl_test_mock_ism: "".to_string(),
        hpl_test_mock_hook: "".to_string(),
        hpl_test_mock_msg_receiver: "".to_string(),
        hpl_mailbox: "".to_string(),
        hpl_validator_announce: "".to_string(),
    }
}

#[apply(as_task)]
pub(crate) fn deploy_all(
    cli: StarknetCLI,
    deployer: String,
    declarations: DeclaredClasses,
    domain: u32,
) -> Deployments {
    // deploy mailbox
    let mailbox = cli.deploy(declarations.hpl_mailbox, vec![domain.to_string(), deployer]);

    // ---------- mock area -----------

    Deployments {
        mailbox,
        ..Default::default()
    }
}
