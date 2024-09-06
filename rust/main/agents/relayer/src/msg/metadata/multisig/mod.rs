mod base;
mod merkle_root_multisig;
mod message_id_multisig;

#[allow(unused_imports)] // TODO: `rustc` 1.80.1 clippy issue
pub use base::{MetadataToken, MultisigIsmMetadataBuilder, MultisigMetadata};

pub use merkle_root_multisig::MerkleRootMultisigMetadataBuilder;
pub use message_id_multisig::MessageIdMultisigMetadataBuilder;
