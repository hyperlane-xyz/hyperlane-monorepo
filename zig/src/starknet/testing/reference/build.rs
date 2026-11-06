//! Same abigen options as production utils/abigen; generated output stays OUT_DIR.
use std::{collections::HashMap, env, fs, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo directory"));
    let abi = root.join("../../../../../rust/main/chains/hyperlane-starknet/abis/Mailbox.abi.json");
    println!("cargo:rerun-if-changed={}", abi.display());
    let mut aliases = HashMap::new();
    aliases.insert(
        "openzeppelin::access::ownable::ownable::OwnableComponent::Event".into(),
        "OwnableCptEvent".into(),
    );
    aliases.insert(
        "openzeppelin::upgrades::upgradeable::UpgradeableComponent::Event".into(),
        "UpgradeableCptEvent".into(),
    );
    aliases.insert("hyperlane_starknet::contracts::client::mailboxclient_component::MailboxclientComponent::Event".into(), "MailboxclientCptEvent".into());
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("cargo output directory")).join("mailbox.rs");
    cainome::rs::Abigen::new("Mailbox", &abi.to_string_lossy())
        .with_types_aliases(aliases)
        .with_execution_version(cainome::rs::ExecutionVersion::V3)
        .with_derives(vec![
            "Debug".into(),
            "PartialEq".into(),
            "serde::Serialize".into(),
            "serde::Deserialize".into(),
        ])
        .with_contract_derives(vec![
            "Debug".into(),
            "Clone".into(),
            "serde::Serialize".into(),
            "serde::Deserialize".into(),
        ])
        .generate()
        .expect("production ABI")
        .write_to_file(output.to_str().expect("output path"))
        .expect("generated bindings");
    // File-level attributes cannot be expanded by include! within a module.
    let code = fs::read_to_string(&output).expect("generated bindings");
    fs::write(
        output,
        code.lines()
            .filter(|line| !line.starts_with("#!["))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .expect("include-compatible bindings");
}
