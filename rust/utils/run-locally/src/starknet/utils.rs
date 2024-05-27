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
    let mut declared_classes = DeclaredClasses::default();
    for (class, path) in sierra_classes {
        println!("Declaring class: {}", class);
        let declare_result = cli.declare(path);
        let class_hash = declare_result.class_hash;
        match class.as_str() {
            "hyperlane_starknet_merkle_tree_hook" => declared_classes.hpl_hook_merkle = class_hash,
            "hyperlane_starknet_mailbox" => declared_classes.hpl_mailbox = class_hash,
            "hyperlane_starknet_ism" => declared_classes.hpl_test_mock_ism = class_hash,
            "hyperlane_starknet_hook" => declared_classes.hpl_test_mock_hook = class_hash,
            "hyperlane_starknet_aggregation" => declared_classes.hpl_ism_aggregate = class_hash,
            "hyperlane_starknet_message_recipient" => {
                declared_classes.hpl_test_mock_msg_receiver = class_hash
            }
            "hyperlane_starknet_messageid_multisig_ism" => {
                declared_classes.hpl_ism_multisig = class_hash
            }
            "hyperlane_starknet_validator_announce" => {
                declared_classes.hpl_validator_announce = class_hash
            }
            "hyperlane_starknet_domain_routing_ism" => {
                declared_classes.hpl_ism_routing = class_hash
            }
            _ => println!("Unknown class: {}", class),
        }
    }

    declared_classes
}

#[apply(as_task)]
pub(crate) fn deploy_all(
    cli: StarknetCLI,
    deployer: String,
    declarations: DeclaredClasses,
    domain: u32,
) -> Deployments {
    // deploy mailbox
    println!("Deploying mailbox");
    let mailbox = cli.deploy(
        declarations.hpl_mailbox,
        vec![domain.to_string(), deployer.clone()],
    );

    // deploy ism - routing ism with empty routes
    println!("Deploying routing ism");
    let ism_routing = cli.deploy(declarations.hpl_ism_routing, vec![deployer.clone()]);

    println!("Initializing routing ism");
    cli.invoke(
        ism_routing.clone(),
        "initialize",
        vec!["0".to_string(), "0".to_string()],
    );

    // deploy ism - multisig ism with no enrolled validators
    println!("Deploying multisig ism");
    let ism_multisig = cli.deploy(declarations.hpl_ism_multisig, vec![deployer.clone()]);

    // TODO: deploy pausable ism

    // deploy ism - aggregation
    println!("Deploying aggregation ism");
    let ism_aggregate = cli.deploy(declarations.hpl_ism_aggregate, vec![deployer.clone()]);
    cli.invoke(
        ism_aggregate.clone(),
        "set_threshold",
        vec!["2".to_string()],
    );
    cli.invoke(
        ism_aggregate.clone(),
        "set_modules",
        vec![ism_multisig.clone()],
    );

    // deploy merkle hook
    println!("Deploying merkle hook");
    let hook_merkle = cli.deploy(declarations.hpl_hook_merkle, vec![mailbox.clone()]);

    // TODO: deploy routing hook

    // deploy va
    println!("Deploying validator announce");
    let va = cli.deploy(declarations.hpl_validator_announce, vec![mailbox.clone()]);

    // ---------- mock area -----------

    // deploy mock receiver
    println!("Deploying mock receiver");
    let mock_receiver = cli.deploy(declarations.hpl_test_mock_msg_receiver, vec![]);

    // deploy mock hook
    println!("Deploying mock hook");
    let mock_hook = cli.deploy(declarations.hpl_test_mock_hook, vec![]);

    let mock_ism = cli.deploy(declarations.hpl_test_mock_ism, vec![]);

    Deployments {
        mailbox,
        ism_routing,
        ism_multisig,
        ism_aggregate,
        hook_merkle,
        va,
        mock_receiver,
        mock_hook,
        mock_ism,
        ..Default::default()
    }
}
