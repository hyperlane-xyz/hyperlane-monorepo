use crate::error::TrieError;
use crate::trie::{keccak256, verify_trie_proof};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EthAccount {
    pub nonce: Vec<u8>,
    pub balance: Vec<u8>,
    pub storage_root: [u8; 32],
    pub code_hash: [u8; 32],
}

impl EthAccount {
    /// Decodes an Ethereum account RLP: [nonce, balance, storageRoot, codeHash].
    pub fn from_rlp(raw: &[u8]) -> Result<Self, TrieError> {
        let rlp = rlp::Rlp::new(raw);
        if !rlp.is_list() {
            return Err(TrieError::InvalidAccountRlp(
                "Account payload is not an RLP list".to_string(),
            ));
        }
        let count = rlp.item_count().map_err(|e| TrieError::RlpError(e.to_string()))?;
        if count != 4 {
            return Err(TrieError::InvalidAccountRlp(format!(
                "Account list expected 4 items, got {count}"
            )));
        }

        let nonce: Vec<u8> = rlp.val_at(0).map_err(|e| TrieError::RlpError(e.to_string()))?;
        let balance: Vec<u8> = rlp.val_at(1).map_err(|e| TrieError::RlpError(e.to_string()))?;
        let storage_root_vec: Vec<u8> = rlp.val_at(2).map_err(|e| TrieError::RlpError(e.to_string()))?;
        let code_hash_vec: Vec<u8> = rlp.val_at(3).map_err(|e| TrieError::RlpError(e.to_string()))?;

        if storage_root_vec.len() != 32 {
            return Err(TrieError::InvalidAccountRlp(format!(
                "storage_root must be 32 bytes, got {}",
                storage_root_vec.len()
            )));
        }
        if code_hash_vec.len() != 32 {
            return Err(TrieError::InvalidAccountRlp(format!(
                "code_hash must be 32 bytes, got {}",
                code_hash_vec.len()
            )));
        }

        let mut storage_root = [0u8; 32];
        storage_root.copy_from_slice(&storage_root_vec);

        let mut code_hash = [0u8; 32];
        code_hash.copy_from_slice(&code_hash_vec);

        Ok(Self {
            nonce,
            balance,
            storage_root,
            code_hash,
        })
    }
}

/// Verifies that an Ethereum account exists in the state trie root and returns the account's storage root.
pub fn verify_account_storage_root(
    state_root: &[u8; 32],
    account_address: &[u8; 20],
    account_proof: &[Vec<u8>],
) -> Result<[u8; 32], TrieError> {
    let account_key = keccak256(account_address);
    let account_rlp = verify_trie_proof(state_root, &account_key, account_proof)?;
    let account = EthAccount::from_rlp(&account_rlp)?;
    Ok(account.storage_root)
}

/// Verifies that a storage slot in an account contains the expected 32-byte value.
pub fn verify_storage_slot_value(
    storage_root: &[u8; 32],
    storage_key_32: &[u8; 32],
    storage_proof: &[Vec<u8>],
    expected_value: &[u8; 32],
) -> Result<bool, TrieError> {
    let trie_key = keccak256(storage_key_32);
    let raw_val = verify_trie_proof(storage_root, &trie_key, storage_proof)?;

    // The value stored in Ethereum storage trie is RLP encoded bytes of the 32-byte word (trimmed of leading zeros or full)
    let decoded_bytes: Vec<u8> = if let Ok(rlp) = rlp::Rlp::new(&raw_val).as_val::<Vec<u8>>() {
        rlp
    } else {
        raw_val
    };

    // Right-align or pad to 32 bytes
    let mut actual_32 = [0u8; 32];
    if decoded_bytes.len() <= 32 {
        let offset = 32 - decoded_bytes.len();
        actual_32[offset..].copy_from_slice(&decoded_bytes);
    } else {
        return Err(TrieError::ValueMismatch {
            expected: hex::encode(expected_value),
            actual: hex::encode(&decoded_bytes),
        });
    }

    if &actual_32 != expected_value {
        return Err(TrieError::ValueMismatch {
            expected: hex::encode(expected_value),
            actual: hex::encode(actual_32),
        });
    }

    Ok(true)
}
