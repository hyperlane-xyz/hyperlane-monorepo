//! Implementation of hyperlane for Starknet.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![deny(warnings)]

use cainome::rs::abigen;

pub use provider::*;
pub use signers::*;
pub use trait_builder::*;
pub use trait_builder::*;

mod bindings;
mod error;
mod mailbox;
mod provider;
mod signers;
mod trait_builder;

abigen!(
    Mailbox,
    "abis/Mailbox.contract_class.json",
     type_aliases {
        openzeppelin::access::ownable::ownable::OwnableComponent::Event as OwnableCptEvent;
        openzeppelin::upgrades::upgradeable::UpgradeableComponent::Event as UpgradeableCptEvent;
     },
    output_path("src/bindings.rs")
);
