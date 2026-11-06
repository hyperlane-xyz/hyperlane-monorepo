//! Runs the production Rust protocol implementation, not a reimplementation.
use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle, Checkpoint, CheckpointWithMessageId, Decode,
    Encode, HyperlaneMessage, Signable, H256,
};
use std::{
    hint::black_box,
    io::{self, BufRead},
    time::Instant,
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if s.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&s[i..i + 2], 16)?))
        .collect()
}

fn message(body_len: usize) -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: 1000,
        sender: H256::repeat_byte(0x11),
        destination: 2000,
        recipient: H256::repeat_byte(0x22),
        body: (0..body_len).map(|i| i as u8).collect(),
    }
}

fn bench(kernel: &str, iterations: u32, body_len: usize) -> Result<(), Box<dyn std::error::Error>> {
    if iterations == 0 {
        return Err("iterations must be positive".into());
    }
    let mut msg = message(body_len);
    let mut checksum = 0u64;
    let mut tree = IncrementalMerkle::default();
    let start = Instant::now();
    match kernel {
        "message_id" => {
            for nonce in 0..iterations {
                msg.nonce = black_box(nonce);
                let id = black_box(msg.id());
                checksum =
                    checksum.wrapping_add(u64::from_be_bytes(id.as_bytes()[..8].try_into()?));
            }
        }
        "message_roundtrip_owned" => {
            for nonce in 0..iterations {
                msg.nonce = black_box(nonce);
                let encoded = black_box(msg.to_vec());
                let decoded = black_box(HyperlaneMessage::read_from(&mut encoded.as_slice())?);
                let id = black_box(decoded.id());
                checksum =
                    checksum.wrapping_add(u64::from_be_bytes(id.as_bytes()[..8].try_into()?));
            }
        }
        "merkle_ingest" => {
            for index in 0..iterations {
                tree.ingest(black_box(H256::from_low_u64_be(u64::from(index))));
            }
            checksum = u64::from_be_bytes(black_box(tree.root()).as_bytes()[..8].try_into()?);
        }
        "merkle_ingest_root" => {
            for index in 0..iterations {
                tree.ingest(black_box(H256::from_low_u64_be(u64::from(index))));
                let root = black_box(tree.root());
                checksum =
                    checksum.wrapping_add(u64::from_be_bytes(root.as_bytes()[..8].try_into()?));
            }
        }
        _ => return Err("unknown benchmark kernel".into()),
    }
    let elapsed_ns = start.elapsed().as_nanos();
    println!(
        "{}",
        serde_json::json!({"kernel":kernel,"iterations":iterations,"body_len":body_len,"elapsed_ns":elapsed_ns,"checksum":format!("{checksum:016x}")})
    );
    Ok(())
}

fn vectors() -> Result<(), Box<dyn std::error::Error>> {
    let mut tree = IncrementalMerkle::default();
    for line in io::stdin().lock().lines() {
        let bytes = unhex(line?.trim())?;
        match HyperlaneMessage::read_from(&mut bytes.as_slice()) {
            Ok(message) => {
                let id = message.id();
                tree.ingest(id);
                let checkpoint = CheckpointWithMessageId {
                    checkpoint: Checkpoint {
                        merkle_tree_hook_address: message.sender,
                        mailbox_domain: message.origin,
                        root: tree.root(),
                        index: tree.index(),
                    },
                    message_id: id,
                };
                println!(
                    "{}",
                    serde_json::json!({"encoded":hex(&message.to_vec()),"id":hex(id.as_bytes()),"root":hex(tree.root().as_bytes()),"count":tree.count(),"signing_hash":hex(checkpoint.signing_hash().as_bytes()), "digest":hex(checkpoint.eth_signed_message_hash().as_bytes())})
                );
            }
            Err(_) => println!("{{\"error\":\"invalid_message\"}}"),
        }
    }
    Ok(())
}

fn crypto_vectors() -> Result<(), Box<dyn std::error::Error>> {
    use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};
    use sha3::{Digest, Keccak256};
    fn address(key: &VerifyingKey) -> String {
        let encoded = key.to_encoded_point(false);
        let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
        hex(&hash[12..])
    }
    fn recover(digest: &[u8], bytes: &[u8]) -> Option<String> {
        if bytes.len() != 65 || ![27, 28].contains(&bytes[64]) {
            return None;
        }
        let signature = Signature::from_slice(&bytes[..64]).ok()?;
        if signature.normalize_s().is_some() {
            return None;
        }
        let id = RecoveryId::try_from(bytes[64] - 27).ok()?;
        let key = VerifyingKey::recover_from_prehash(digest, &signature, id).ok()?;
        Some(address(&key))
    }
    for line in io::stdin().lock().lines() {
        let bytes = unhex(line?.trim())?;
        if bytes.len() != 64 && bytes.len() != 129 {
            return Err("crypto vector must be 64 or 129 bytes".into());
        }
        let key = SigningKey::from_slice(&bytes[..32])?;
        let digest = &bytes[32..64];
        let (signature, recovery_id) = key.sign_prehash_recoverable(digest)?;
        if recovery_id.to_byte() > 1 {
            return Err("Ethereum recovery ID not representable".into());
        }
        let mut serialized = signature.to_bytes().to_vec();
        serialized.push(27 + recovery_id.to_byte());
        let external = if bytes.len() == 129 {
            &bytes[64..]
        } else {
            &serialized
        };
        println!(
            "{}",
            serde_json::json!({"address": address(key.verifying_key()), "signature":hex(&serialized), "recovered":recover(digest,external)})
        );
    }
    Ok(())
}

fn storage_vectors() -> Result<(), Box<dyn std::error::Error>> {
    use hyperlane_core::{
        accumulator::incremental::MerkleTreeSnapshot, Announcement, ReorgEvent, ReorgPeriod,
        Signature, SignedType, H160, U256,
    };
    use k256::ecdsa::SigningKey;
    fn chunks(value: &str) -> Vec<String> {
        value
            .chars()
            .collect::<Vec<_>>()
            .chunks(32)
            .map(|chunk| chunk.iter().collect())
            .collect()
    }
    fn sign<T: Signable>(value: T) -> Result<SignedType<T>, Box<dyn std::error::Error>> {
        let key = SigningKey::from_bytes((&[0x11; 32]).into())?;
        let (signature, recovery) =
            key.sign_prehash_recoverable(value.eth_signed_message_hash().as_bytes())?;
        let signature = signature.to_bytes();
        Ok(SignedType {
            value,
            signature: Signature {
                r: U256::from_big_endian(&signature[..32]),
                s: U256::from_big_endian(&signature[32..]),
                v: 27 + u64::from(recovery.to_byte()),
            },
        })
    }
    for index in [0, 42, u32::MAX] {
        let value = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: H256::repeat_byte(0x22),
                mailbox_domain: 1000,
                root: H256::repeat_byte(0x33),
                index,
            },
            message_id: H256::repeat_byte(0x44),
        };
        let signed = sign(value)?;
        let wire = serde_json::to_string_pretty(&signed)?;
        println!(
            "{}",
            serde_json::json!({"kind":"checkpoint","name":format!("index_{index}"),"wire_utf8_chunks":chunks(&wire),"signing_hash":chunks(&hex(value.signing_hash().as_bytes())),"digest":chunks(&hex(value.eth_signed_message_hash().as_bytes()))})
        );
        let mut alias = serde_json::to_value(&signed)?;
        let object = alias.as_object_mut().ok_or("signed checkpoint is object")?;
        let value = object.remove("value").ok_or("missing checkpoint value")?;
        object.insert("checkpoint".into(), value);
        let alias_wire = serde_json::to_string(&alias)?;
        let decoded: SignedType<CheckpointWithMessageId> = serde_json::from_str(&alias_wire)?;
        assert_eq!(serde_json::to_string_pretty(&decoded)?, wire);
        println!(
            "{}",
            serde_json::json!({"kind":"checkpoint_alias","name":format!("checkpoint_alias_{index}"),"wire_utf8_chunks":chunks(&alias_wire),"canonical_wire_utf8_chunks":chunks(&wire)})
        );
    }
    for location in [
        "file:///tmp/validator",
        "s3://public-fixture/us-east-1",
        "file:///tmp/quoted\"-unicode-λ-\npath",
    ] {
        let value = Announcement {
            validator: H160::repeat_byte(0x11),
            mailbox_address: H256::repeat_byte(0x22),
            mailbox_domain: 1000,
            storage_location: location.into(),
        };
        let signing_hash = value.signing_hash();
        let digest = value.eth_signed_message_hash();
        let signed = sign(value)?;
        let wire = serde_json::to_string_pretty(&signed)?;
        println!(
            "{}",
            serde_json::json!({"kind":"announcement","name":location,"wire_utf8_chunks":chunks(&wire),"signing_hash":chunks(&hex(signing_hash.as_bytes())),"digest":chunks(&hex(digest.as_bytes()))})
        );
        let mut alias = serde_json::to_value(&signed)?;
        let object = alias
            .as_object_mut()
            .ok_or("signed announcement is object")?;
        let value = object.remove("value").ok_or("missing announcement value")?;
        object.insert("announcement".into(), value);
        let alias_wire = serde_json::to_string(&alias)?;
        let decoded: SignedType<Announcement> = serde_json::from_str(&alias_wire)?;
        assert_eq!(serde_json::to_string_pretty(&decoded)?, wire);
        println!(
            "{}",
            serde_json::json!({"kind":"announcement_alias","name":location,"wire_utf8_chunks":chunks(&alias_wire),"canonical_wire_utf8_chunks":chunks(&wire)})
        );
    }
    for count in [1, 2, 17, 256] {
        let mut tree = IncrementalMerkle::default();
        for leaf in 0..count {
            tree.ingest(H256::from_low_u64_be(leaf));
        }
        let snapshot = MerkleTreeSnapshot::capture(&tree)?;
        let wire = serde_json::to_string(&snapshot)?;
        println!(
            "{}",
            serde_json::json!({"kind":"snapshot","name":format!("count_{count}"),"wire_utf8_chunks":chunks(&wire),"borsh_hex_chunks":chunks(&hex(&snapshot.tree)),"count":count,"root":chunks(&hex(snapshot.root.as_bytes()))})
        );
    }
    for period in [
        ReorgPeriod::None,
        ReorgPeriod::from_blocks(5),
        ReorgPeriod::Tag("finalized".into()),
    ] {
        let event = ReorgEvent {
            local_merkle_root: H256::repeat_byte(0x11),
            canonical_merkle_root: H256::repeat_byte(0x22),
            checkpoint_index: 42,
            unix_timestamp: 1234567890,
            reorg_period: period,
        };
        let wire = serde_json::to_string_pretty(&event)?;
        println!(
            "{}",
            serde_json::json!({"kind":"reorg_event","name":format!("{:?}",event.reorg_period),"wire_utf8_chunks":chunks(&wire),"response_exists":true,"response_event_valid":true})
        );
    }
    println!(
        "{}",
        serde_json::json!({"kind":"reorg_malformed","name":"malformed","wire_utf8_chunks":["not valid JSON"],"response_exists":true,"response_event_valid":false})
    );
    for index in [0, 42, u32::MAX] {
        println!(
            "{}",
            serde_json::json!({"kind":"latest_index","name":format!("index_{index}"),"wire_utf8_chunks":[index.to_string()],"index":index})
        );
    }
    Ok(())
}

fn checkpoint_digests() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let signed: hyperlane_core::SignedType<CheckpointWithMessageId> =
            serde_json::from_str(&line?)?;
        println!(
            "{}",
            serde_json::json!({"digest":hex(signed.value.eth_signed_message_hash().as_bytes())})
        );
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("vectors") => vectors(),
        Some("crypto-vectors") => crypto_vectors(),
        Some("storage-vectors") => storage_vectors(),
        Some("checkpoint-digests") => checkpoint_digests(),
        Some("bench") if args.len() == 5 => bench(&args[2], args[3].parse()?, args[4].parse()?),
        _ => Err("usage: ziggy-rust-reference vectors | bench KERNEL ITERATIONS BODY_LEN".into()),
    }
}
