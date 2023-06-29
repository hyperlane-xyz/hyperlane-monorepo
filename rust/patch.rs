#!/usr/bin/env rust-script
//! A rust script to update the patches for this workspace.
//!
//! ```cargo
//! [dependencies]
//! cargo_toml = "0.15.3"
//! toml = "0.7.1"
//! patcher = { path = "utils/patcher", version = "0.1.7" }
//! ```

use std::path::{Path, PathBuf};

use cargo_toml::{Dependency, DependencyDetail, Manifest};

const SOLANA_VERSION: &str = "1.14.13";

const PATCHES: &[PatchDirective] = &[
    PatchDirective {
        name: "solana",
        url: "https://github.com/solana-labs/solana.git",
        rev: None,
        tag: Some("v1.14.13"),
        patches: &["solana-tokio.patch", "solana-aes-gcm-siv.patch"],
        crates: &[
            PatchCrateDirective {
                name: "solana-account-decoder",
                version: SOLANA_VERSION,
                path: "account-decoder",
            },
            PatchCrateDirective {
                name: "solana-banks-client",
                version: SOLANA_VERSION,
                path: "banks-client",
            },
            PatchCrateDirective {
                name: "solana-banks-interface",
                version: SOLANA_VERSION,
                path: "banks-interface",
            },
            PatchCrateDirective {
                name: "solana-banks-server",
                version: SOLANA_VERSION,
                path: "banks-server",
            },
            PatchCrateDirective {
                name: "solana-clap-utils",
                version: SOLANA_VERSION,
                path: "clap-utils",
            },
            PatchCrateDirective {
                name: "solana-cli-config",
                version: SOLANA_VERSION,
                path: "cli-config",
            },
            PatchCrateDirective {
                name: "solana-client",
                version: SOLANA_VERSION,
                path: "client",
            },
            PatchCrateDirective {
                name: "solana-program",
                version: SOLANA_VERSION,
                path: "sdk/program",
            },
            PatchCrateDirective {
                name: "solana-program-test",
                version: SOLANA_VERSION,
                path: "program-test",
            },
            PatchCrateDirective {
                name: "solana-sdk",
                version: SOLANA_VERSION,
                path: "sdk",
            },
            PatchCrateDirective {
                name: "solana-transaction-status",
                version: SOLANA_VERSION,
                path: "transaction-status",
            },
            PatchCrateDirective {
                name: "solana-zk-token-sdk",
                version: SOLANA_VERSION,
                path: "zk-token-sdk",
            },
        ],
    },
    PatchDirective {
        name: "spl",
        url: "https://github.com/Eclipse-Laboratories-Inc/eclipse-program-library.git",
        rev: Some("891b4bdad856a6101367ca1b3c1e9bace5ec8986"),
        tag: None,
        patches: &[
            "spl-steven-fixes.patch",
            "spl-tlv-lib.patch",
            "spl-display-for-pods.patch",
        ],
        crates: &[
            PatchCrateDirective { name: "spl-associated-token-account", version: "1.1.2", path: "associated-token-account/program" },
            PatchCrateDirective { name: "spl-noop", version: "0.1.3", path: "account-compression/programs/noop" },
            PatchCrateDirective { name: "spl-token", version: "3.5.0", path: "token/program" },
            PatchCrateDirective { name: "spl-token-2022", version: "0.5.0", path: "token/program-2022" },
            PatchCrateDirective { name: "spl-type-length-value", version: "0.1.0", path: "libraries/type-length-value" }
        ],
    },
];

struct PatchDirective {
    /// Name of the monorepo
    name: &'static str,
    url: &'static str,
    rev: Option<&'static str>,
    tag: Option<&'static str>,
    patches: &'static [&'static str],
    crates: &'static [PatchCrateDirective],
}

struct PatchCrateDirective {
    /// Name of the crate
    name: &'static str,
    /// Version of the crate `x.y.z`
    version: &'static str,
    /// Relative path to the monorepo root
    path: &'static str,
}

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
    for directive in PATCHES {
        directive.run(&mut manifest, &patch_dir);
    }
    let mut manifest: String = toml::to_string_pretty(&manifest).unwrap();
    manifest.insert_str(0, "# This file is updated by `patch.rs`;\n# changes will be incorporated but will be reformatted and comments will be lost.\n\n");
    std::fs::write("Cargo.toml", manifest).expect("Failed to write Cargo.toml");

    std::fs::write(PathBuf::from(PATCH_DIR).join(".gitignore"), "solana\nspl")
        .expect("Failed to write .gitignore");
}

impl PatchDirective {
    fn run(&self, manifest: &mut Manifest, patch_dir: &Path) {
        let crates: std::collections::BTreeMap<_, _> =
            self.crates.iter().map(|c| (c.name, c)).collect();
        if crates.len() != self.crates.len() {
            panic!("Duplicate crate name in {}", self.name);
        }

        let mut patcher = patcher::Patcher::default();
        if let Some(tag) = self.tag {
            patcher.repo_tag(tag);
        }
        if let Some(rev) = self.rev {
            patcher.repo_rev(rev);
        }
        patcher
            .repo_url(self.url)
            .patch_with_multiple(self.patches.iter().copied())
            .working_dir(patch_dir)
            .dest_dir(self.name)
            .clone_dir(format!("{}_remote", self.name))
            .run();

        let dir = patch_dir.join(self.name);
        for (_, c) in crates {
            patch_dep(manifest, c.name, c.version, &dir.join(c.path));
        }
        for entry in dir.read_dir().unwrap().map(Result::unwrap) {
            if !entry.file_type().unwrap().is_dir() {
                std::fs::remove_file(entry.path()).unwrap();
            }
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
