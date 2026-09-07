use std::collections::HashMap;
use sha3::{Digest, Keccak256};
use crate::error::TrieError;

/// Converts a 32-byte key to 64 nibbles (4 bits each).
pub fn key_to_nibbles(key: &[u8]) -> Vec<u8> {
    let mut nibbles = Vec::with_capacity(key.len() * 2);
    for &byte in key {
        nibbles.push(byte >> 4);
        nibbles.push(byte & 0x0f);
    }
    nibbles
}

/// Decodes hex-prefix (compact) encoded path into (is_leaf, nibbles).
pub fn decode_compact_path(compact: &[u8]) -> Result<(bool, Vec<u8>), TrieError> {
    if compact.is_empty() {
        return Err(TrieError::InvalidPathEncoding("Empty compact path".to_string()));
    }
    let first = compact[0];
    let prefix = first >> 4;
    let is_leaf = prefix >= 2;
    let is_odd = (prefix & 1) == 1;

    let mut nibbles = Vec::new();
    if is_odd {
        nibbles.push(first & 0x0f);
    }
    for &byte in &compact[1..] {
        nibbles.push(byte >> 4);
        nibbles.push(byte & 0x0f);
    }
    Ok((is_leaf, nibbles))
}

/// Computes the Keccak256 hash of bytes.
pub fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    out
}

/// Verifies a Merkle-Patricia Trie proof for a key against a root hash.
/// Returns the decoded raw value bytes at the key.
pub fn verify_trie_proof(
    root_hash: &[u8; 32],
    key: &[u8], // unhashed or pre-hashed key (32 bytes)
    proof_nodes: &[Vec<u8>],
) -> Result<Vec<u8>, TrieError> {
    if proof_nodes.is_empty() {
        return Err(TrieError::EmptyProof);
    }

    // Build proof lookup map by keccak256(node_bytes) -> node_bytes
    let mut node_map: HashMap<Vec<u8>, &[u8]> = HashMap::with_capacity(proof_nodes.len());
    for node in proof_nodes {
        let hash = keccak256(node);
        node_map.insert(hash.to_vec(), node.as_slice());
    }

    let key_nibbles = key_to_nibbles(key);
    let mut current_key_index = 0usize;
    let mut expected_node_ref = root_hash.to_vec();

    loop {
        // Retrieve current node data
        let node_raw: &[u8] = if expected_node_ref.len() == 32 {
            node_map.get(&expected_node_ref).copied().ok_or_else(|| {
                TrieError::NodeHashMismatch {
                    expected: hex::encode(&expected_node_ref),
                    actual: "missing in proof".to_string(),
                }
            })?
        } else {
            // Inline node (length < 32 bytes)
            &expected_node_ref
        };

        // Parse RLP list
        let rlp = rlp::Rlp::new(node_raw);
        if !rlp.is_list() {
            return Err(TrieError::InvalidNodeStructure(
                "Trie node is not an RLP list".to_string(),
            ));
        }

        let item_count = rlp.item_count().map_err(|e| TrieError::RlpError(e.to_string()))?;

        if item_count == 2 {
            // Extension or Leaf node: [compact_path, value_or_child]
            let compact_path: Vec<u8> = rlp.val_at(0).map_err(|e| TrieError::RlpError(e.to_string()))?;
            let (is_leaf, path_nibbles) = decode_compact_path(&compact_path)?;

            if is_leaf {
                // Leaf node: path must match remaining key nibbles exactly
                let remaining_key = &key_nibbles[current_key_index..];
                if remaining_key != path_nibbles.as_slice() {
                    return Err(TrieError::KeyNotFound {
                        depth: current_key_index,
                    });
                }
                // Extract value
                let value_bytes: Vec<u8> = rlp.val_at(1).map_err(|e| TrieError::RlpError(e.to_string()))?;
                return Ok(value_bytes);
            } else {
                // Extension node: path_nibbles must match prefix of remaining key nibbles
                let path_len = path_nibbles.len();
                if current_key_index + path_len > key_nibbles.len() {
                    return Err(TrieError::KeyNotFound {
                        depth: current_key_index,
                    });
                }
                let key_prefix = &key_nibbles[current_key_index..current_key_index + path_len];
                if key_prefix != path_nibbles.as_slice() {
                    return Err(TrieError::KeyNotFound {
                        depth: current_key_index,
                    });
                }
                current_key_index += path_len;
                let child_raw: Vec<u8> = rlp.val_at(1).map_err(|e| TrieError::RlpError(e.to_string()))?;
                expected_node_ref = child_raw;
            }
        } else if item_count == 17 {
            // Branch node: 16 children + 1 value
            if current_key_index == key_nibbles.len() {
                // Key ends at this branch node, return branch value
                let value_bytes: Vec<u8> = rlp.val_at(16).map_err(|e| TrieError::RlpError(e.to_string()))?;
                if value_bytes.is_empty() {
                    return Err(TrieError::KeyNotFound {
                        depth: current_key_index,
                    });
                }
                return Ok(value_bytes);
            }

            let next_nibble = key_nibbles[current_key_index] as usize;
            current_key_index += 1;

            let child_item = rlp.at(next_nibble).map_err(|e| TrieError::RlpError(e.to_string()))?;
            if child_item.is_empty() {
                return Err(TrieError::KeyNotFound {
                    depth: current_key_index,
                });
            }

            let child_data = child_item.as_raw();
            if child_data.len() == 32 {
                // 32-byte hash
                let mut hash = vec![0u8; 32];
                hash.copy_from_slice(child_data);
                expected_node_ref = hash;
            } else if child_item.is_data() && child_item.data().map(|d| d.len() == 32).unwrap_or(false) {
                expected_node_ref = child_item.data().unwrap().to_vec();
            } else {
                // Could be RLP string of 32 bytes or raw inline node
                if let Ok(data) = child_item.data() {
                    if data.len() == 32 {
                        expected_node_ref = data.to_vec();
                    } else {
                        expected_node_ref = child_data.to_vec();
                    }
                } else {
                    expected_node_ref = child_data.to_vec();
                }
            }
        } else {
            return Err(TrieError::InvalidNodeStructure(format!(
                "Unexpected node item count: {item_count}"
            )));
        }
    }
}
