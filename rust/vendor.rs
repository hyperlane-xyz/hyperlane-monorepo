#!/usr/bin/env rust-script
//! A rust script to update the patches for this workspace.
//! Run simply as `./vendor.rs` after installing [rust-script](https://rust-script.org/)
//! with `cargo install rust-script`.
//!
//! I am aware of the generated cargo warnings and have created an issue with the hope that
//! the `cargo_toml` crate will be updated to fix this.
//! https://gitlab.com/crates.rs/cargo_toml/-/issues/26
//!
//!
//! ```cargo
//! [dependencies]
//! patcher = { path = "utils/patcher", version = "0.5.1" }
//! ```

use patcher::borrowed::{PatchCrateDirective, PatchDirective, Refspec::*};

macro_rules! constants {
    (solana_ver) => {
        "1.14.13"
    };
    (solana_ref) => {
        concat!("v", constants!(solana_ver))
    };
    (patch_dir) => {
        "vendor"
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
        refspec: Branch("master"),
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
        refspec: Branch("master"),
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

fn main() {
    patcher::patch_workspace(
        std::env::current_dir().unwrap(),
        constants!(patch_dir),
        PATCHES.into_iter().copied().map(Into::into),
    )
}
