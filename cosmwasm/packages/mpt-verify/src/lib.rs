use rlp::Rlp;
use thiserror::Error;
use tiny_keccak::{Hasher, Keccak};

#[derive(Error, Debug, PartialEq, Eq)]
pub enum MptError {
    #[error("Empty proof provided")]
    EmptyProof,
    #[error("Root hash mismatch: expected {expected}, got {actual}")]
    RootMismatch { expected: String, actual: String },
    #[error("Node hash mismatch at step {step}: expected {expected}, got {actual}")]
    NodeHashMismatch {
        step: usize,
        expected: String,
        actual: String,
    },
    #[error("RLP decode error: {0}")]
    RlpError(String),
    #[error("Invalid node format: expected list of length 2 or 17, got {0}")]
    InvalidNodeLength(usize),
    #[error("Key path mismatch in branch node at nibble index {0}")]
    BranchPathMismatch(usize),
    #[error("Key path mismatch in extension/leaf node")]
    ExtensionPathMismatch,
    #[error("Expected leaf node, found extension node")]
    ExpectedLeafNode,
    #[error("Target key not fully consumed at leaf: consumed {consumed} of {total}")]
    IncompleteKeyConsumption { consumed: usize, total: usize },
    #[error("Invalid compact path encoding")]
    InvalidCompactEncoding,
    #[error("Invalid account encoding")]
    InvalidAccountEncoding,
    #[error("Invalid 32-byte hash length")]
    InvalidHashLength,
}

impl From<rlp::DecoderError> for MptError {
    fn from(err: rlp::DecoderError) -> Self {
        MptError::RlpError(err.to_string())
    }
}

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut keccak = Keccak::v256();
    keccak.update(data);
    let mut output = [0u8; 32];
    keccak.finalize(&mut output);
    output
}

pub fn bytes_to_nibbles(bytes: &[u8]) -> Vec<u8> {
    let mut nibbles = Vec::with_capacity(bytes.len() * 2);
    for &b in bytes {
        nibbles.push(b >> 4);
        nibbles.push(b & 0x0f);
    }
    nibbles
}

pub fn decode_compact_path(encoded: &[u8]) -> Result<(bool, Vec<u8>), MptError> {
    if encoded.is_empty() {
        return Err(MptError::InvalidCompactEncoding);
    }

    let first = encoded[0];
    let flag = first >> 4;
    let is_leaf = (flag & 0x02) != 0;
    let is_odd = (flag & 0x01) != 0;

    let mut nibbles = Vec::new();
    if is_odd {
        nibbles.push(first & 0x0f);
    }

    for &b in &encoded[1..] {
        nibbles.push(b >> 4);
        nibbles.push(b & 0x0f);
    }

    Ok((is_leaf, nibbles))
}

pub fn encode_compact_path(nibbles: &[u8], is_leaf: bool) -> Vec<u8> {
    let is_odd = nibbles.len() % 2 != 0;
    let flag: u8 = (if is_leaf { 0x02 } else { 0x00 }) | (if is_odd { 0x01 } else { 0x00 });

    let mut result = Vec::with_capacity((nibbles.len() / 2) + 1);
    if is_odd {
        result.push((flag << 4) | (nibbles[0] & 0x0f));
        for i in (1..nibbles.len()).step_by(2) {
            result.push((nibbles[i] << 4) | (nibbles[i + 1] & 0x0f));
        }
    } else {
        result.push(flag << 4);
        for i in (0..nibbles.len()).step_by(2) {
            result.push((nibbles[i] << 4) | (nibbles[i + 1] & 0x0f));
        }
    }
    result
}

pub fn verify_mpt_proof(
    root_hash: &[u8; 32],
    target_key: &[u8],
    proof: &[Vec<u8>],
) -> Result<Vec<u8>, MptError> {
    if proof.is_empty() {
        return Err(MptError::EmptyProof);
    }

    let target_nibbles = bytes_to_nibbles(target_key);
    let mut expected_hash = *root_hash;
    let mut nibble_idx = 0;

    for (step, node_bytes) in proof.iter().enumerate() {
        if node_bytes.len() >= 32 {
            let actual_hash = keccak256(node_bytes);
            if actual_hash != expected_hash {
                return Err(MptError::NodeHashMismatch {
                    step,
                    expected: hex::encode(expected_hash),
                    actual: hex::encode(actual_hash),
                });
            }
        } else if node_bytes.as_slice() != expected_hash.as_slice() {
            return Err(MptError::NodeHashMismatch {
                step,
                expected: hex::encode(expected_hash),
                actual: hex::encode(node_bytes),
            });
        }

        let rlp = Rlp::new(node_bytes);
        let item_count = rlp.item_count()?;

        match item_count {
            2 => {
                let encoded_path = rlp.val_at::<Vec<u8>>(0)?;
                let (is_leaf, path_nibbles) = decode_compact_path(&encoded_path)?;

                if nibble_idx + path_nibbles.len() > target_nibbles.len() {
                    return Err(MptError::ExtensionPathMismatch);
                }

                if target_nibbles[nibble_idx..nibble_idx + path_nibbles.len()] != path_nibbles[..] {
                    return Err(MptError::ExtensionPathMismatch);
                }

                nibble_idx += path_nibbles.len();

                if is_leaf {
                    if nibble_idx != target_nibbles.len() {
                        return Err(MptError::IncompleteKeyConsumption {
                            consumed: nibble_idx,
                            total: target_nibbles.len(),
                        });
                    }
                    let value = rlp.val_at::<Vec<u8>>(1)?;
                    return Ok(value);
                } else {
                    let next_node_ref = rlp.at(1)?;
                    if next_node_ref.is_data() {
                        let data = next_node_ref.data()?;
                        if data.len() == 32 {
                            expected_hash.copy_from_slice(data);
                        } else {
                            return Err(MptError::InvalidHashLength);
                        }
                    } else {
                        expected_hash = keccak256(next_node_ref.as_raw());
                    }
                }
            }
            17 => {
                if nibble_idx == target_nibbles.len() {
                    let value = rlp.val_at::<Vec<u8>>(16)?;
                    return Ok(value);
                }

                let branch_nibble = target_nibbles[nibble_idx] as usize;
                if branch_nibble > 15 {
                    return Err(MptError::BranchPathMismatch(nibble_idx));
                }

                nibble_idx += 1;
                let next_node_ref = rlp.at(branch_nibble)?;

                if next_node_ref.is_empty() {
                    return Err(MptError::BranchPathMismatch(nibble_idx - 1));
                }

                if next_node_ref.is_data() {
                    let data = next_node_ref.data()?;
                    if data.len() == 32 {
                        expected_hash.copy_from_slice(data);
                    } else if data.is_empty() {
                        return Err(MptError::BranchPathMismatch(nibble_idx - 1));
                    } else {
                        expected_hash = keccak256(next_node_ref.as_raw());
                    }
                } else {
                    expected_hash = keccak256(next_node_ref.as_raw());
                }
            }
            other => return Err(MptError::InvalidNodeLength(other)),
        }
    }

    Err(MptError::ExpectedLeafNode)
}

pub struct EthereumAccount {
    pub nonce: u64,
    pub balance: Vec<u8>,
    pub storage_root: [u8; 32],
    pub code_hash: [u8; 32],
}

pub fn verify_account_proof(
    state_root: &[u8; 32],
    address: &[u8; 20],
    account_proof: &[Vec<u8>],
) -> Result<EthereumAccount, MptError> {
    let key = keccak256(address);
    let account_rlp_bytes = verify_mpt_proof(state_root, &key, account_proof)?;

    let rlp = Rlp::new(&account_rlp_bytes);
    if rlp.item_count()? != 4 {
        return Err(MptError::InvalidAccountEncoding);
    }

    let nonce: u64 = rlp.val_at(0)?;
    let balance: Vec<u8> = rlp.val_at(1)?;
    let storage_root_bytes: Vec<u8> = rlp.val_at(2)?;
    let code_hash_bytes: Vec<u8> = rlp.val_at(3)?;

    if storage_root_bytes.len() != 32 || code_hash_bytes.len() != 32 {
        return Err(MptError::InvalidAccountEncoding);
    }

    let mut storage_root = [0u8; 32];
    storage_root.copy_from_slice(&storage_root_bytes);

    let mut code_hash = [0u8; 32];
    code_hash.copy_from_slice(&code_hash_bytes);

    Ok(EthereumAccount {
        nonce,
        balance,
        storage_root,
        code_hash,
    })
}

pub fn verify_storage_proof(
    storage_root: &[u8; 32],
    storage_key: &[u8; 32],
    storage_proof: &[Vec<u8>],
) -> Result<[u8; 32], MptError> {
    let key = keccak256(storage_key);
    let raw_val = verify_mpt_proof(storage_root, &key, storage_proof)?;

    let rlp = Rlp::new(&raw_val);
    let value_bytes: Vec<u8> = if rlp.is_data() {
        rlp.as_val()?
    } else {
        raw_val
    };

    let mut result = [0u8; 32];
    if value_bytes.len() > 32 {
        return Err(MptError::InvalidHashLength);
    }
    result[32 - value_bytes.len()..].copy_from_slice(&value_bytes);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rlp::RlpStream;

    #[test]
    fn test_compact_path_roundtrip() {
        let nibbles = vec![1, 2, 3, 4, 5];
        let encoded = encode_compact_path(&nibbles, true);
        let (is_leaf, decoded) = decode_compact_path(&encoded).unwrap();
        assert!(is_leaf);
        assert_eq!(decoded, nibbles);

        let nibbles_even = vec![1, 2, 3, 4];
        let encoded_even = encode_compact_path(&nibbles_even, false);
        let (is_leaf_even, decoded_even) = decode_compact_path(&encoded_even).unwrap();
        assert!(!is_leaf_even);
        assert_eq!(decoded_even, nibbles_even);
    }

    #[test]
    fn test_single_leaf_mpt_proof() {
        let key = [0xabu8; 32];
        let value = b"hello world".to_vec();

        let nibbles = bytes_to_nibbles(&key);
        let encoded_path = encode_compact_path(&nibbles, true);

        let mut stream = RlpStream::new_list(2);
        stream.append(&encoded_path);
        stream.append(&value);
        let leaf_node = stream.out().to_vec();

        let root_hash = keccak256(&leaf_node);
        let proof = vec![leaf_node];

        let retrieved = verify_mpt_proof(&root_hash, &key, &proof).unwrap();
        assert_eq!(retrieved, value);
    }

    #[test]
    fn test_branch_and_leaf_mpt_proof() {
        let key = [0x12u8; 32];
        let value = b"hyperlane message proof".to_vec();
        let target_nibbles = bytes_to_nibbles(&key);

        let first_nibble = target_nibbles[0] as usize;
        let remaining_nibbles = &target_nibbles[1..];

        let encoded_leaf_path = encode_compact_path(remaining_nibbles, true);
        let mut leaf_stream = RlpStream::new_list(2);
        leaf_stream.append(&encoded_leaf_path);
        leaf_stream.append(&value);
        let leaf_node = leaf_stream.out().to_vec();
        let leaf_hash = keccak256(&leaf_node);

        let mut branch_stream = RlpStream::new_list(17);
        for i in 0..16 {
            if i == first_nibble {
                branch_stream.append(&leaf_hash.as_slice());
            } else {
                branch_stream.append_empty_data();
            }
        }
        branch_stream.append_empty_data();
        let branch_node = branch_stream.out().to_vec();
        let root_hash = keccak256(&branch_node);

        let proof = vec![branch_node, leaf_node];
        let retrieved = verify_mpt_proof(&root_hash, &key, &proof).unwrap();
        assert_eq!(retrieved, value);
    }

    #[test]
    fn test_account_and_storage_proof_verification() {
        let address = [0x42u8; 20];
        let code_hash = [0x88u8; 32];
        let storage_key = [0x99u8; 32];
        let storage_val = [0xaau8; 32];

        let mut val_stream = RlpStream::new();
        val_stream.append(&storage_val.as_slice());
        let storage_val_rlp = val_stream.out().to_vec();

        let storage_hashed_key = keccak256(&storage_key);
        let storage_nibbles = bytes_to_nibbles(&storage_hashed_key);
        let encoded_storage_path = encode_compact_path(&storage_nibbles, true);

        let mut storage_node_stream = RlpStream::new_list(2);
        storage_node_stream.append(&encoded_storage_path);
        storage_node_stream.append(&storage_val_rlp);
        let storage_node = storage_node_stream.out().to_vec();
        let storage_root = keccak256(&storage_node);

        let mut account_stream = RlpStream::new_list(4);
        account_stream.append(&1u64); // nonce
        account_stream.append(&vec![0x00u8]); // balance
        account_stream.append(&storage_root.as_slice()); // storageRoot
        account_stream.append(&code_hash.as_slice()); // codeHash
        let account_rlp = account_stream.out().to_vec();

        let account_key = keccak256(&address);
        let account_nibbles = bytes_to_nibbles(&account_key);
        let encoded_account_path = encode_compact_path(&account_nibbles, true);

        let mut account_node_stream = RlpStream::new_list(2);
        account_node_stream.append(&encoded_account_path);
        account_node_stream.append(&account_rlp);
        let account_node = account_node_stream.out().to_vec();
        let state_root = keccak256(&account_node);

        let account_proof = vec![account_node];
        let account = verify_account_proof(&state_root, &address, &account_proof).unwrap();
        assert_eq!(account.storage_root, storage_root);

        let storage_proof = vec![storage_node];
        let verified_val = verify_storage_proof(&storage_root, &storage_key, &storage_proof).unwrap();
        assert_eq!(verified_val, storage_val);
    }
}
