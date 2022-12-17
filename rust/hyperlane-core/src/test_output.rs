/// Test functions that output json files
#[cfg(feature = "output")]
pub mod output_functions {

    use std::{fs::OpenOptions, io::Write, str::FromStr};

    use hyperlane_ethereum::Signers;
    use hex::FromHex;
    use serde_json::{json, Value};

    use crate::{
        accumulator::{
            merkle::{merkle_root_from_branch, MerkleTree},
            TREE_DEPTH,
        },
        test_utils::find_vector,
        utils::domain_hash,
        Checkpoint, HyperlaneMessage, H160, H256,
    };

    /// Output proof to /vector/message.json
    pub fn output_message() {
        let hyperlane_message = HyperlaneMessage {
            nonce: 0,
            version: 0,
            origin: 1000,
            sender: H256::from(
                H160::from_str("0x1111111111111111111111111111111111111111").unwrap(),
            ),
            destination: 2000,
            recipient: H256::from(
                H160::from_str("0x2222222222222222222222222222222222222222").unwrap(),
            ),
            body: Vec::from_hex("1234").unwrap(),
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
            .open(find_vector("message.json"))
            .expect("Failed to open/create file");

        file.write_all(json.as_bytes())
            .expect("Failed to write to file");
    }

    /// Output merkle proof test vectors
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
            .open(find_vector("proof.json"))
            .expect("Failed to open/create file");

        file.write_all(json.as_bytes())
            .expect("Failed to write to file");
    }

    /// Outputs domain hash test cases in /vector/domainHash.json
    pub fn output_domain_hashes() {
        let mailbox =
            H256::from(H160::from_str("0x2222222222222222222222222222222222222222").unwrap());
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
            .open(find_vector("domainHash.json"))
            .expect("Failed to open/create file");

        file.write_all(json.as_bytes())
            .expect("Failed to write to file");
    }

    /// Outputs signed checkpoint test cases in /vector/signedCheckpoint.json
    pub fn output_signed_checkpoints() {
        let mailbox =
            H256::from(H160::from_str("0x2222222222222222222222222222222222222222").unwrap());
        let t = async {
            let signer: Signers =
                "1111111111111111111111111111111111111111111111111111111111111111"
                    .parse::<ethers::signers::LocalWallet>()
                    .unwrap()
                    .into();

            let mut test_cases: Vec<Value> = Vec::new();

            // test suite
            for i in 1..=3 {
                let signed_checkpoint = Checkpoint {
                    mailbox_address: mailbox,
                    mailbox_domain: 1000,
                    root: H256::repeat_byte(i + 1),
                    index: i as u32,
                }
                .sign_with(&signer)
                .await
                .expect("!sign_with");

                test_cases.push(json!({
                    "mailbox": signed_checkpoint.checkpoint.mailbox_address,
                    "domain": signed_checkpoint.checkpoint.mailbox_domain,
                    "root": signed_checkpoint.checkpoint.root,
                    "index": signed_checkpoint.checkpoint.index,
                    "signature": signed_checkpoint.signature,
                    "signer": signer.address(),
                }))
            }

            let json = json!(test_cases).to_string();

            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(find_vector("signedCheckpoint.json"))
                .expect("Failed to open/create file");

            file.write_all(json.as_bytes())
                .expect("Failed to write to file");
        };

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(t)
    }
}
