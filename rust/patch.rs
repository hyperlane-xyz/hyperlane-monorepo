#!/usr/bin/env rust-script
//! A rust script to update the patches for this workspace.
//! Run simply as `./patch.rs` after installing [rust-script](https://rust-script.org/)
//! with `cargo install rust-script`.
//!
//! ```cargo
//! [dependencies]
//! cargo_toml = "0.15.3"
//! toml = "0.7.1"
//! patcher = { path = "utils/patcher", version = "0.2.10" }
//! ```

use std::borrow::ToOwned;
use std::path::{Path, PathBuf};

use cargo_toml::{Dependency, DependencyDetail, Manifest};
use patcher::Patcher;
use Refspec::*;

macro_rules! constants {
    (solana_ver) => {
        "1.14.13"
    };
    (solana_ref) => {
        concat!("v", constants!(solana_ver))
    };
}

const PATCHES: &[PatchDirective] = &[
    PatchDirective {
        name: "solana",
        url: "https://github.com/solana-labs/solana.git",
        refspec: Tag(constants!(solana_ref)),
        patches: &[
            "solana-tokio.patch",
            "solana-aes-gcm-siv.patch",
            "solana-ed25519-dalek-keypair.patch",
        ],
        crates: &[
            PatchCrateDirective {
                name: "solana-account-decoder",
                version: constants!(solana_ver),
                path: "account-decoder",
            },
            PatchCrateDirective {
                name: "solana-banks-client",
                version: constants!(solana_ver),
                path: "banks-client",
            },
            PatchCrateDirective {
                name: "solana-banks-interface",
                version: constants!(solana_ver),
                path: "banks-interface",
            },
            PatchCrateDirective {
                name: "solana-banks-server",
                version: constants!(solana_ver),
                path: "banks-server",
            },
            PatchCrateDirective {
                name: "solana-clap-utils",
                version: constants!(solana_ver),
                path: "clap-utils",
            },
            PatchCrateDirective {
                name: "solana-cli-config",
                version: constants!(solana_ver),
                path: "cli-config",
            },
            PatchCrateDirective {
                name: "solana-client",
                version: constants!(solana_ver),
                path: "client",
            },
            PatchCrateDirective {
                name: "solana-program",
                version: constants!(solana_ver),
                path: "sdk/program",
            },
            PatchCrateDirective {
                name: "solana-program-test",
                version: constants!(solana_ver),
                path: "program-test",
            },
            PatchCrateDirective {
                name: "solana-sdk",
                version: constants!(solana_ver),
                path: "sdk",
            },
            PatchCrateDirective {
                name: "solana-transaction-status",
                version: constants!(solana_ver),
                path: "transaction-status",
            },
            PatchCrateDirective {
                name: "solana-zk-token-sdk",
                version: constants!(solana_ver),
                path: "zk-token-sdk",
            },
        ],
    },
    PatchDirective {
        name: "spl",
        url: "https://github.com/Eclipse-Laboratories-Inc/eclipse-program-library.git",
        refspec: Rev("891b4bdad856a6101367ca1b3c1e9bace5ec8986"), // master@2023-06-29
        patches: &[
            "spl-steven-fixes.patch",
            "spl-tlv-lib.patch",
            "spl-display-for-pods.patch",
        ],
        crates: &[
            PatchCrateDirective {
                name: "spl-associated-token-account",
                version: "1.1.2",
                path: "associated-token-account/program",
            },
            PatchCrateDirective {
                name: "spl-noop",
                version: "0.1.3",
                path: "account-compression/programs/noop",
            },
            PatchCrateDirective {
                name: "spl-token",
                version: "3.5.0",
                path: "token/program",
            },
            PatchCrateDirective {
                name: "spl-token-2022",
                version: "0.5.0",
                path: "token/program-2022",
            },
            PatchCrateDirective {
                name: "spl-type-length-value",
                version: "0.1.0",
                path: "libraries/type-length-value",
            },
        ],
    },
    PatchDirective {
        name: "parity-common",
        url: "https://github.com/Eclipse-Laboratories-Inc/parity-common.git",
        refspec: Rev("c41d51df8a314150c46cbbff31f8140a35dfb02c"), // master@2023-06-29
        patches: &["primitive-types-borsh.patch"],
        crates: &[
            PatchCrateDirective {
                name: "primitive-types",
                version: "0.12.1",
                path: "primitive-types",
            },
            PatchCrateDirective {
                name: "rlp",
                version: "0.5.2",
                path: "rlp",
            },
        ],
    },
];

#[derive(Copy, Clone)]
struct PatchDirective {
    /// Name of the monorepo
    name: &'static str,
    url: &'static str,
    refspec: Refspec,
    patches: &'static [&'static str],
    crates: &'static [PatchCrateDirective],
}

#[derive(Copy, Clone)]
struct PatchCrateDirective {
    /// Name of the crate
    name: &'static str,
    /// Version of the crate `x.y.z`
    version: &'static str,
    /// Relative path to the monorepo root
    path: &'static str,
}

#[derive(Copy, Clone)]
enum Refspec {
    Tag(&'static str),
    Rev(&'static str),
    // Branch(&'static str),
}

impl From<Refspec> for patcher::Refspec {
    fn from(r: Refspec) -> Self {
        match r {
            Tag(tag) => patcher::Refspec::Tag(tag.to_owned()),
            Rev(rev) => patcher::Refspec::Rev(rev.to_owned()),
            // Branch(branch) => patcher::Refspec::Branch(branch.to_owned()),
        }
    }
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

    std::fs::write(
        PathBuf::from(PATCH_DIR).join(".gitignore"),
        PATCHES
            .into_iter()
            .map(|p| p.name)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .expect("Failed to write .gitignore");
}

impl PatchDirective {
    fn run(&self, manifest: &mut Manifest, patch_dir: &Path) {
        let crates: std::collections::BTreeMap<_, _> =
            self.crates.iter().map(|c| (c.name, c)).collect();
        if crates.len() != self.crates.len() {
            panic!("Duplicate crate name in {}", self.name);
        }

        Patcher::default()
            .repo_ref(self.refspec.into())
            .repo_url(self.url)
            .patch_with_multiple(self.patches.iter().copied())
            .working_dir(patch_dir)
            .dest_dir(self.name)
            .clone_dir(format!("{}_remote", self.name))
            .run();

        let dir = patch_dir.join(self.name);
        let colored: std::rc::Rc<std::cell::RefCell<std::collections::HashSet<PathBuf>>> =
            Default::default();
        for (_, c) in crates {
            let dep_path = dir.join(c.path);
            patch_dep(manifest, c.name, c.version, &dep_path);
            suppress_warnings(&dep_path, colored.clone());
        }

        if self.crates.len() == 1 && self.crates[0].path == "." {
            // Not a monorepo, probably fine to leave things as they are
        } else {
            for entry in dir.read_dir().unwrap().map(Result::unwrap) {
                if !entry.file_type().unwrap().is_dir() {
                    std::fs::remove_file(entry.path()).unwrap();
                }
            }
        }
    }
}

fn patch_dep(manifest: &mut Manifest, name: &str, version: &str, path: &Path) {
    println!("Patching {} to {}", name, version);
    let path: PathBuf = path
        .components()
        .filter(|c| c.as_os_str().to_str() != Some("."))
        .collect();
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

fn suppress_warnings(
    crate_path: &Path,
    colored: std::rc::Rc<std::cell::RefCell<std::collections::HashSet<PathBuf>>>,
) {
    println!("Suppressing warnings in {}", crate_path.display());
    let lib_root_path = crate_path.join("src").join("lib.rs");
    if lib_root_path.is_file() {
        let raw = std::fs::read_to_string(&lib_root_path).expect("Failed to read lib.rs");
        let lib_root = raw
            .lines()
            .filter(|l| !(l.starts_with("#![") && l.contains("warnings")));
        let raw = ["#![allow(warnings)]"]
            .into_iter()
            .chain(lib_root)
            .collect::<Vec<&str>>()
            .join("\n");
        std::fs::write(lib_root_path, raw).expect("Failed to write lib.rs");
    }
    let manifest_path = crate_path.join("Cargo.toml");
    if manifest_path.is_file() {
        let dep_paths: Vec<PathBuf> = {
            // do this in a subscope so we can free up the memory of the manifest
            let raw = std::fs::read_to_string(&manifest_path).expect("Failed to read Cargo.toml");
            let manifest = Manifest::from_str(&raw).expect("Failed to parse Cargo.toml");
            manifest
                .dependencies
                .values()
                .filter_map(|d| d.detail())
                .filter_map(|d| d.path.as_ref())
                .filter_map(|p| crate_path.join(p).canonicalize().ok())
                .filter(|p| colored.borrow_mut().insert(p.clone()))
                .collect()
        };
        for dep_path in dep_paths {
            if !colored.borrow_mut().insert(dep_path.clone()) {
                // have not seen it before so recurse
                suppress_warnings(&dep_path, colored.clone())
            };
        }
    }
}
