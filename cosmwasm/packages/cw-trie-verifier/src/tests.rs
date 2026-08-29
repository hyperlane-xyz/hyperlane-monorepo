use super::*;

#[test]
fn test_compact_path_decoding() {
    // Leaf with even length: prefix 0x20
    let compact_leaf_even = vec![0x20, 0x12, 0x34];
    let (is_leaf, nibbles) = decode_compact_path(&compact_leaf_even).unwrap();
    assert!(is_leaf);
    assert_eq!(nibbles, vec![1, 2, 3, 4]);

    // Leaf with odd length: prefix 0x35
    let compact_leaf_odd = vec![0x35, 0x67];
    let (is_leaf, nibbles) = decode_compact_path(&compact_leaf_odd).unwrap();
    assert!(is_leaf);
    assert_eq!(nibbles, vec![5, 6, 7]);

    // Extension with even length: prefix 0x00
    let compact_ext_even = vec![0x00, 0xab, 0xcd];
    let (is_leaf, nibbles) = decode_compact_path(&compact_ext_even).unwrap();
    assert!(!is_leaf);
    assert_eq!(nibbles, vec![0xa, 0xb, 0xc, 0xd]);

    // Extension with odd length: prefix 0x1f
    let compact_ext_odd = vec![0x1f, 0x89];
    let (is_leaf, nibbles) = decode_compact_path(&compact_ext_odd).unwrap();
    assert!(!is_leaf);
    assert_eq!(nibbles, vec![0xf, 8, 9]);
}

#[test]
fn test_key_to_nibbles() {
    let key = vec![0x1a, 0x2b, 0x3c];
    let nibbles = key_to_nibbles(&key);
    assert_eq!(nibbles, vec![1, 0xa, 2, 0xb, 3, 0xc]);
}

#[test]
fn test_account_rlp_decoding() {
    let storage_root = [0x44u8; 32];
    let code_hash = [0x55u8; 32];
    let nonce = 42u64;
    let balance = 1_000_000u128;

    let mut stream = rlp::RlpStream::new_list(4);
    stream.append(&nonce);
    stream.append(&balance);
    stream.append(&storage_root.as_ref());
    stream.append(&code_hash.as_ref());
    let encoded = stream.out().to_vec();

    let account = EthAccount::from_rlp(&encoded).unwrap();
    assert_eq!(account.storage_root, storage_root);
    assert_eq!(account.code_hash, code_hash);
}

#[test]
fn test_single_leaf_trie_proof_verification() {
    let key = [0x11u8; 32];
    let key_nibbles = key_to_nibbles(&key);
    let value = b"hello_hyperlane_cosmwasm";

    // Build leaf node: [compact_path, value]
    let mut compact_path = vec![0x20];
    for chunk in key_nibbles.chunks(2) {
        compact_path.push((chunk[0] << 4) | chunk[1]);
    }

    let mut stream = rlp::RlpStream::new_list(2);
    stream.append(&compact_path);
    stream.append(&value.as_ref());
    let leaf_raw = stream.out().to_vec();

    let root_hash = keccak256(&leaf_raw);
    let proof = vec![leaf_raw];

    let result = verify_trie_proof(&root_hash, &key, &proof).unwrap();
    assert_eq!(result, value);
}

#[test]
fn test_branch_and_leaf_trie_proof_verification() {
    let key = [0xa5u8; 32]; // First nibble is 0xa, remaining nibbles follow
    let key_nibbles = key_to_nibbles(&key);
    let value = b"verified_message_id_data";

    // Leaf node for key_nibbles[1..] (63 nibbles -> odd length, prefix 0x30 | nibble[1])
    let first_leaf_nibble = key_nibbles[1];
    let mut compact_leaf = vec![0x30 | first_leaf_nibble];
    for chunk in key_nibbles[2..].chunks(2) {
        compact_leaf.push((chunk[0] << 4) | chunk[1]);
    }

    let mut leaf_stream = rlp::RlpStream::new_list(2);
    leaf_stream.append(&compact_leaf);
    leaf_stream.append(&value.as_ref());
    let leaf_raw = leaf_stream.out().to_vec();
    let leaf_hash = keccak256(&leaf_raw);

    // Branch node: 16 children + 1 value. Child at index 0xa (10) is leaf_hash
    let mut branch_stream = rlp::RlpStream::new_list(17);
    for i in 0..16 {
        if i == 0xa {
            branch_stream.append(&leaf_hash.as_ref());
        } else {
            branch_stream.append_empty_data();
        }
    }
    branch_stream.append_empty_data(); // value at branch
    let branch_raw = branch_stream.out().to_vec();
    let root_hash = keccak256(&branch_raw);

    let proof = vec![branch_raw, leaf_raw];

    let result = verify_trie_proof(&root_hash, &key, &proof).unwrap();
    assert_eq!(result, value);
}

#[test]
fn test_storage_slot_verification() {
    let storage_key_32 = [0x88u8; 32];
    let trie_key = keccak256(&storage_key_32);
    let trie_nibbles = key_to_nibbles(&trie_key);
    let expected_message_id = [0x99u8; 32];

    // RLP encode the 32-byte word
    let mut val_stream = rlp::RlpStream::new();
    val_stream.append(&expected_message_id.as_ref());
    let rlp_val = val_stream.out().to_vec();

    let mut compact_path = vec![0x20];
    for chunk in trie_nibbles.chunks(2) {
        compact_path.push((chunk[0] << 4) | chunk[1]);
    }

    let mut leaf_stream = rlp::RlpStream::new_list(2);
    leaf_stream.append(&compact_path);
    leaf_stream.append(&rlp_val);
    let leaf_raw = leaf_stream.out().to_vec();

    let root_hash = keccak256(&leaf_raw);
    let proof = vec![leaf_raw];

    let verified = verify_storage_slot_value(
        &root_hash,
        &storage_key_32,
        &proof,
        &expected_message_id,
    ).unwrap();
    assert!(verified);
}
