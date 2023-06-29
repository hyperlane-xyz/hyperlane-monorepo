#!/usr/bin/env rust-script
//! A rust script to update the patches for this workspace.
//!
//! ```cargo
//! [dependencies]
//! cargo_toml = "0.15.3"
//! toml = "0.7.1"
//! patcher = { path = "utils/patcher" }
//! ```

use std::path::PathBuf;

use cargo_toml::{Dependency, DependencyDetail, Manifest};

const SOLANA_VERSION: &str = "1.14.13";
const SOLANA_CRATES: &[(&str, &str)] = &[
    ("solana-account-decoder", "account-decoder"),
    ("solana-banks-client", "banks-client"),
    ("solana-banks-interface", "banks-interface"),
    ("solana-banks-server", "banks-server"),
    ("solana-clap-utils", "clap-utils"),
    ("solana-cli-config", "cli-config"),
    ("solana-client", "client"),
    ("solana-program", "sdk/program"),
    ("solana-program-test", "program-test"),
    ("solana-sdk", "sdk"),
    ("solana-transaction-status", "transaction-status"),
    ("solana-zk-token-sdk", "zk-token-sdk"),
];
const SOLANA_REPO: &str = "https://github.com/solana-labs/solana.git";
const SOLANA_PATCHES: &[&str] = &["solana-tokio.patch", "solana-aes-gcm-siv.patch"];
const PATCH_DIR: &str = "patches";

fn main() {
    // do not complete this since we want to write it back more or less as it was
    let mut manifest = {
        let raw_manifest =
            std::fs::read_to_string("Cargo.toml").expect("Failed to read Cargo.toml");
        Manifest::from_str(&raw_manifest).expect("Failed to load Cargo.toml")
    };

    patch_solana(&mut manifest);
    let mut manifest: String = toml::to_string_pretty(&manifest).unwrap();
    manifest.insert_str(0, "# This file is updated by `patch.rs`;\n# changes will be incorporated but will be reformatted and comments will be lost.\n\n");
    std::fs::write("Cargo.toml", manifest).expect("Failed to write Cargo.toml");

    std::fs::write(PathBuf::from(PATCH_DIR).join(".gitignore"), "solana")
        .expect("Failed to write .gitignore");
}

fn patch_solana(manifest: &mut Manifest) {
    let solana_crates: std::collections::BTreeMap<&'static str, &'static str> =
        SOLANA_CRATES.into_iter().copied().collect();
    let patch_dir = PathBuf::from(PATCH_DIR);
    if !patch_dir.exists() {
        panic!("Patch dir does not exist: {}", patch_dir.display());
    }
    if solana_crates.len() != SOLANA_CRATES.len() {
        panic!("Duplicate crate name in SOLANA_CRATES");
    }

    patcher::Patcher::default()
        .repo_url(SOLANA_REPO)
        .repo_tag(&format!("v{SOLANA_VERSION}"))
        .patch_with_multiple(SOLANA_PATCHES.iter().copied())
        .working_dir(&patch_dir)
        .dest_dir("solana")
        .clone_dir("solana_remote")
        .run();

    let solana_dir = patch_dir.join("solana");
    for (&dep_name, &dep_path) in solana_crates.iter() {
        manifest
            .workspace
            .as_mut()
            .expect("No workspace dependencies!?")
            .dependencies
            .insert(
                dep_name.to_owned(),
                Dependency::Simple(format!("={SOLANA_VERSION}")),
            );
        manifest
            .patch
            .entry("crates-io".to_owned())
            .or_default()
            .insert(
                dep_name.to_owned(),
                Dependency::Detailed(DependencyDetail {
                    version: Some(format!("={SOLANA_VERSION}")),
                    path: Some(solana_dir.join(dep_path).to_str().unwrap().to_owned()),
                    ..DependencyDetail::default()
                }),
            );
    }
    // remove extra crap from the solana dir
    for entry in solana_dir.read_dir().unwrap().map(Result::unwrap) {
        if !entry.file_type().unwrap().is_dir() {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
}
