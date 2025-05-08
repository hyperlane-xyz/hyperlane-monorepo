use macro_rules_attribute::apply;
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::program::Program;
use crate::utils::{as_task, TaskHandle};

use super::cli::StarknetCLI;
use super::types::{DeclaredClasses, Deployments};

pub(crate) const STARKNET_ACCOUNT: &str = "katana-0";

pub(crate) fn untar(output: &str, dir: &str) {
    Program::new("tar")
        .raw_arg("-xzvf")
        .cmd(output)
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
        "unknown-linux-gnu"
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
        if !class.starts_with("contracts_") {
            continue;
        }

        println!("Declaring class: {}", class);
        let declare_result = cli.declare(path);
        let class_hash = declare_result.class_hash;
        match class.as_str() {
            "contracts_merkle_tree_hook" => declared_classes.hpl_hook_merkle = class_hash,
            "contracts_mailbox" => declared_classes.hpl_mailbox = class_hash,
            "contracts_ism" => declared_classes.hpl_test_mock_ism = class_hash,
            "contracts_pausable_ism" => declared_classes.hpl_ism_pausable = class_hash,
            "contracts_hook" => declared_classes.hpl_test_mock_hook = class_hash,
            "contracts_aggregation" => declared_classes.hpl_ism_aggregate = class_hash,
            "contracts_message_recipient" => {
                declared_classes.hpl_test_mock_msg_receiver = class_hash
            }
            "contracts_messageid_multisig_ism" => declared_classes.hpl_ism_multisig = class_hash,
            "contracts_validator_announce" => declared_classes.hpl_validator_announce = class_hash,
            "contracts_domain_routing_ism" => declared_classes.hpl_ism_routing = class_hash,
            _ => println!("Unknown class: {}", class),
        }
    }

    declared_classes
}

const VALIDATOR_ADDRESS: &str = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const THRESHOLD: &str = "1";

#[apply(as_task)]
pub(crate) fn deploy_all(
    cli: StarknetCLI,
    deployer: String,
    declarations: DeclaredClasses,
    domain: u32,
    remotes: Vec<u32>,
) -> Deployments {
    // deploy ism - multisig ism with no enrolled validators
    println!("Deploying message id multisig ism");
    let ism_multisig = cli.deploy(
        declarations.hpl_ism_multisig,
        vec![
            deployer.clone(),
            "1".to_string(),
            VALIDATOR_ADDRESS.to_string(),
            THRESHOLD.to_string(),
        ],
    );

    // deploy pausable ism
    println!("Deploying pausable ism");
    let ism_pausable = cli.deploy(declarations.hpl_ism_pausable, vec![deployer.clone()]);

    // deploy ism - aggregation
    println!("Deploying aggregation ism");
    let ism_aggregate = cli.deploy(
        declarations.hpl_ism_aggregate,
        vec![
            deployer.clone(),
            "2".to_string(),
            ism_multisig.clone(),
            ism_pausable.clone(),
            "2".to_string(),
        ],
    );

    // deploy ism - routing ism
    println!("Deploying routing ism");
    let default_ism = cli.deploy(declarations.hpl_ism_routing, vec![deployer.clone()]);

    println!(
        "Initializing routing ism with for origin domains: {:?}",
        remotes
    );
    cli.invoke(
        default_ism.clone(),
        "initialize",
        vec![
            remotes.len().to_string(),
            remotes
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(" "),
            remotes.len().to_string(),
            vec![ism_aggregate.clone(); remotes.len()].join(" "),
        ],
    );
    // deploy mock hook
    println!("Deploying mock hook");
    let mock_hook = cli.deploy(declarations.hpl_test_mock_hook, vec![]);

    // deploy mailbox
    println!("Deploying mailbox");
    let mailbox = cli.deploy(
        declarations.hpl_mailbox,
        vec![
            domain.to_string(),
            deployer.clone(),
            default_ism.clone(),
            mock_hook.clone(),
            mock_hook.clone(),
        ],
    );

    // deploy merkle hook
    println!("Deploying merkle hook");
    let hook_merkle = cli.deploy(
        declarations.hpl_hook_merkle,
        vec![mailbox.clone(), deployer.clone()],
    );

    // set default/required hook

    // ---------- mock area -----------

    // deploy mock receiver
    println!("Deploying mock receiver");
    let mock_receiver = cli.deploy(
        declarations.hpl_test_mock_msg_receiver,
        vec![default_ism.clone()],
    );

    let mock_ism = cli.deploy(declarations.hpl_test_mock_ism, vec![]);

    println!("Setting default/required hook");
    cli.invoke(
        mailbox.clone(),
        "set_default_hook",
        vec![hook_merkle.clone()],
    );
    cli.invoke(
        mailbox.clone(),
        "set_required_hook",
        vec![hook_merkle.clone()],
    );

    // TODO: deploy routing hook

    // deploy va
    println!("Deploying validator announce");
    let va = cli.deploy(
        declarations.hpl_validator_announce,
        vec![mailbox.clone(), deployer.clone()],
    );

    Deployments {
        mailbox,
        ism_routing: default_ism,
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

/// Convert a byte slice to a starknet message
/// We have to pad the bytes to 16 bytes chunks
/// see here for more info https://github.com/keep-starknet-strange/alexandria/blob/main/src/bytes/src/bytes.cairo#L16
pub(crate) fn to_strk_message_bytes(bytes: &[u8]) -> (u32, Vec<u128>) {
    // Calculate the required padding
    let padding = (16 - (bytes.len() % 16)) % 16;
    let total_len = bytes.len() + padding;

    // Create a new byte vector with the necessary padding
    let mut padded_bytes = Vec::with_capacity(total_len);
    padded_bytes.extend_from_slice(bytes);
    padded_bytes.extend(std::iter::repeat(0).take(padding));

    let mut result = Vec::with_capacity(total_len / 16);
    for chunk in padded_bytes.chunks_exact(16) {
        // Convert each 16-byte chunk into a u128
        let mut array = [0u8; 16];
        array.copy_from_slice(chunk);
        result.push(u128::from_be_bytes(array));
    }

    (bytes.len() as u32, result)
}
