pub mod account;
pub mod error;
pub mod trie;

#[cfg(test)]
mod tests;

pub use account::{
    verify_account_storage_root, verify_storage_slot_value, EthAccount,
};
pub use error::TrieError;
pub use trie::{
    decode_compact_path, keccak256, key_to_nibbles, verify_trie_proof,
};
