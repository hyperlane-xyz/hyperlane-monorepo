#!/usr/bin/env rust-script
//! A rust script to update the patches for this workspace.
//!
//! ```cargo
//! [dependencies]
//! cargo_toml = "0.15.3"
//! toml = "0.7.1"
//! patcher = { path = "utils/patcher", version = "0.1.1" }
//! ```

use std::path::{Path, PathBuf};

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

const SPL_CRATES: &[(&str, &str, &str)] = &[
    (
        "spl-associated-token-account",
        "1.1.2",
        "associated-token-account/program",
    ),
    ("spl-noop", "0.1.3", "account-compression/programs/noop"),
    ("spl-token", "3.5.0", "token/program"),
    ("spl-token-2022", "0.5.0", "token/program-2022"),
    ("spl-type-length-value", "0.1.0", "libraries/type-length-value"),
];
const SPL_REPO: &str = "https://github.com/Eclipse-Laboratories-Inc/eclipse-program-library.git";
/// Main branch as of 2023-06-29
const SPL_REV: &str = "891b4bdad856a6101367ca1b3c1e9bace5ec8986";
const SPL_BRANCH: &str = "master";
const SPL_PATCHES: &[&str] = &[
    "spl-steven-fixes.patch",
    "spl-tlv-lib.patch",
    "spl-display-for-pods.patch",
];

const PATCH_DIR: &str = "patches";

fn main() {
    // do not complete this since we want to write it back more or less as it was
    let mut manifest = {
        let raw_manifest =
            std::fs::read_to_string("Cargo.toml").expect("Failed to read Cargo.toml");
        Manifest::from_str(&raw_manifest).expect("Failed to load Cargo.toml")
    };

    let patch_dir = PathBuf::from(PATCH_DIR);
    if !patch_dir.exists() {
        panic!("Patch dir does not exist: {}", patch_dir.display());
    }
    patch_solana(&mut manifest, &patch_dir);
    patch_spl(&mut manifest, &patch_dir);
    let mut manifest: String = toml::to_string_pretty(&manifest).unwrap();
    manifest.insert_str(0, "# This file is updated by `patch.rs`;\n# changes will be incorporated but will be reformatted and comments will be lost.\n\n");
    std::fs::write("Cargo.toml", manifest).expect("Failed to write Cargo.toml");

    std::fs::write(PathBuf::from(PATCH_DIR).join(".gitignore"), "solana\nspl")
        .expect("Failed to write .gitignore");
}

fn patch_solana(manifest: &mut Manifest, patch_dir: &Path) {
    let solana_crates: std::collections::BTreeMap<&'static str, &'static str> =
        SOLANA_CRATES.into_iter().copied().collect();

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
    for (dep_name, dep_path) in solana_crates {
        patch_dep(
            manifest,
            dep_name,
            SOLANA_VERSION,
            &solana_dir.join(dep_path),
        );
    }
    // remove extra crap from the solana dir
    for entry in solana_dir.read_dir().unwrap().map(Result::unwrap) {
        if !entry.file_type().unwrap().is_dir() {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
}

fn patch_spl(manifest: &mut Manifest, patch_dir: &Path) {
    let spl_crates: std::collections::BTreeMap<&'static str, (&'static str, &'static str)> =
        SPL_CRATES.into_iter().map(|t| (t.0, (t.1, t.2))).collect();

    patcher::Patcher::default()
        .repo_url(SPL_REPO)
        .repo_tag(SPL_BRANCH)
        .repo_rev(SPL_REV)
        .patch_with_multiple(SPL_PATCHES.iter().copied())
        .working_dir(&patch_dir)
        .dest_dir("spl")
        .clone_dir("spl_remote")
        .run();

    let spl_dir = patch_dir.join("spl");
    for (dep_name, (dep_version, dep_path)) in spl_crates {
        patch_dep(manifest, dep_name, dep_version, &spl_dir.join(dep_path));
    }

    for entry in spl_dir.read_dir().unwrap().map(Result::unwrap) {
        if !entry.file_type().unwrap().is_dir() {
            std::fs::remove_file(entry.path()).unwrap();
        }
    }
}

fn patch_dep(manifest: &mut Manifest, name: &str, version: &str, path: &Path) {
    manifest
        .workspace
        .as_mut()
        .expect("No workspace dependencies!?")
        .dependencies
        .insert(name.to_owned(), Dependency::Simple(format!("={version}")));
    manifest
        .patch
        .entry("crates-io".to_owned())
        .or_default()
        .insert(
            name.to_owned(),
            Dependency::Detailed(DependencyDetail {
                version: Some(format!("={version}")),
                path: Some(path.to_str().unwrap().to_owned()),
                ..DependencyDetail::default()
            }),
        );
}
