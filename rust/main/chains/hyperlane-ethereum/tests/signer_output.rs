//! Test functions that output json files

#![cfg(test)]

use std::{fs::OpenOptions, io::Write, str::FromStr};

use hex::FromHex;
use serde_json::{json, Value};

use hyperlane_core::{
    accumulator::{
        merkle::{merkle_root_from_branch, MerkleTree},
        TREE_DEPTH,
    },
    test_utils,
    utils::domain_hash,
    HyperlaneMessage, H160, H256,
};

/// Output proof to /vector/message.json
#[test]
pub fn output_message() {
    let hyperlane_message = HyperlaneMessage {
        nonce: 0,
        version: 3,
        origin: 1000,
        sender: H256::from(H160::from_str("0x1111111111111111111111111111111111111111").unwrap()),
        destination: 2000,
        recipient: H256::from(
            H160::from_str("0x2222222222222222222222222222222222222222").unwrap(),
        ),
        body: Vec::from_hex("1234").unwrap(),
        id: std::sync::OnceLock::new(),
    };

    let message_json = json!({
        "nonce": hyperlane_message.nonce,
        "version": hyperlane_message.version,
        "origin": hyperlane_message.origin,
        "sender": hyperlane_message.sender,
        "destination": hyperlane_message.destination,
        "recipient": hyperlane_message.recipient,
        "body": hyperlane_message.body,
        "id": hyperlane_message.id(),
    });
    let json = json!([message_json]).to_string();

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(test_utils::find_vector("message.json"))
        .expect("Failed to open/create file");

    file.write_all(json.as_bytes())
        .expect("Failed to write to file");
}

/// Output merkle proof test vectors
#[test]
pub fn output_merkle_proof() {
    let mut tree = MerkleTree::create(&[], TREE_DEPTH);

    let index = 1;

    // kludge. these are random message ids
    tree.push_leaf(
        "0xd89959d277019eee21f1c3c270a125964d63b71876880724d287fbb8b8de55f1"
            .parse()
            .unwrap(),
        TREE_DEPTH,
    )
    .unwrap();
    tree.push_leaf(
        "0x5068ac60cb6f9c5202bbe8e7a1babdd972133ea3ad37d7e0e753c7e4ddd7ffbd"
            .parse()
            .unwrap(),
        TREE_DEPTH,
    )
    .unwrap();
    let proof = tree.generate_proof(index, TREE_DEPTH);

    let proof_json = json!({ "leaf": proof.0, "path": proof.1, "index": index});
    let json = json!({ "proof": proof_json, "root": merkle_root_from_branch(proof.0, &proof.1, 32, index)}).to_string();

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(test_utils::find_vector("proof.json"))
        .expect("Failed to open/create file");

    file.write_all(json.as_bytes())
        .expect("Failed to write to file");
}

/// Outputs domain hash test cases in /vector/domainHash.json
#[test]
pub fn output_domain_hashes() {
    let mailbox = H256::from(H160::from_str("0x2222222222222222222222222222222222222222").unwrap());
    let test_cases: Vec<Value> = (1..=3)
        .map(|i| {
            json!({
                "domain": i,
                "mailbox": mailbox,
                "expectedDomainHash": domain_hash(mailbox, i as u32)
            })
        })
        .collect();

    let json = json!(test_cases).to_string();

    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(test_utils::find_vector("domainHash.json"))
        .expect("Failed to open/create file");

    file.write_all(json.as_bytes())
        .expect("Failed to write to file");
}
