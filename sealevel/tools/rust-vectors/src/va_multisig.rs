//! Vectors for ecdsa-signature, multisig-ism, quote-verifier,
//! validator-announce and multisig-ism-message-id.
//!
//! Recovery entries (`recover_*`) pack `hash(32) || signature(65) ||
//! public key(64) || address(20)`, from solana-program's native
//! secp256k1_recover, so Go tests can stand in for the syscall exactly.

use account_utils::{AccountData, DiscriminatorEncode, SizedData};
use borsh::BorshSerialize;
use ecdsa_signature::{EcdsaSignature, EcdsaSignatureError};
use hyperlane_core::{
    Announcement, CheckpointWithMessageId, Encode, HyperlaneMessage, Signable, H160, H256,
};
use hyperlane_sealevel_multisig_ism_message_id::{
    accounts::{AccessControlData, DomainData},
    instruction::{Domained, Instruction as MultisigProgramInstruction, ValidatorsAndThreshold},
};
use hyperlane_sealevel_validator_announce::{
    accounts::{ReplayProtection, ValidatorAnnounce, ValidatorStorageLocations},
    instruction::{AnnounceInstruction, InitInstruction, Instruction as VaInstruction},
};
use k256::ecdsa::SigningKey;
use multisig_ism::{
    error::MultisigIsmError, interface::MultisigIsmInstruction, multisig::MultisigIsm,
    test_data::get_multisig_ism_test_data, MultisigIsmMessageIdMetadata,
};
use quote_verifier::{QuoteValidationError, QuoteVerifyError, SvmSignedQuote, ValidatableQuote};
use serde_json::{Map, Value};
use solana_program::{clock::Clock, keccak, pubkey::Pubkey, secp256k1_recover::secp256k1_recover};
use std::collections::BTreeSet;
use std::str::FromStr;

use super::{seq20, seq32, Group};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn account<T: BorshSerialize + borsh::BorshDeserialize + Default>(v: T) -> Vec<u8> {
    let n = 1 + borsh::to_vec(&v).unwrap().len();
    let mut buf = vec![0xffu8; n];
    AccountData::from(v).store_in_slice(&mut buf).unwrap();
    buf
}

/// Adds a `recover_<name>` entry for (hash, 65-byte signature) and returns
/// the recovered address.
fn recover(g: &mut Group, name: &str, hash: &[u8; 32], sig: &[u8]) -> H160 {
    let s = EcdsaSignature::from_bytes(sig).unwrap();
    let key = secp256k1_recover(hash, s.recovery_id, &s.serialized_rs).unwrap();
    let address = s.secp256k1_recover_ethereum_address(hash).unwrap();
    let mut b = hash.to_vec();
    b.extend_from_slice(sig);
    b.extend_from_slice(&key.to_bytes());
    b.extend_from_slice(address.as_bytes());
    g.ok(&format!("recover_{name}"), b);
    address
}

fn ecdsa_error_code(e: EcdsaSignatureError) -> u8 {
    match e {
        EcdsaSignatureError::InvalidLength => 1,
        EcdsaSignatureError::InvalidRecoveryId => 2,
        EcdsaSignatureError::HighS => 3,
    }
}

const HALF_ORDER: [u8; 32] = [
    0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0x5D, 0x57, 0x6E, 0x73, 0x57, 0xA4, 0x50, 0x1D, 0xDF, 0xE9, 0x2F, 0x46, 0x68, 0x1B, 0x20, 0xA0,
];

struct Payload(H256);
impl Signable for Payload {
    fn signing_hash(&self) -> H256 {
        self.0
    }
}

fn ecdsa_group() -> Group {
    let mut g = Group::new();
    // from_bytes: "from_bytes_<case>" holds the input, ok = Rust accepts;
    // "from_bytes_<case>_result" is [error code (0 = ok), recovery id].
    let mut cases: Vec<(&str, Vec<u8>)> = vec![
        ("len64", vec![0u8; 64]),
        ("len66", vec![0u8; 66]),
        ("empty", vec![]),
    ];
    for v in [0u8, 1, 2, 3, 26, 27, 28, 29, 255] {
        let mut b = vec![0x11u8; 32];
        b.extend_from_slice(&[0x22u8; 32]);
        b.push(v);
        cases.push((Box::leak(format!("v{v}").into_boxed_str()), b));
    }
    let mut at_half = vec![0x11u8; 32];
    at_half.extend_from_slice(&HALF_ORDER);
    at_half.push(27);
    cases.push(("s_half_order", at_half.clone()));
    let mut above = at_half.clone();
    above[63] += 1;
    cases.push(("s_half_order_plus_one", above));
    let mut high = at_half.clone();
    high[32..64].fill(0xff);
    cases.push(("s_max", high));
    let mut low_high_byte = at_half.clone();
    low_high_byte[32] = 0x7f;
    low_high_byte[33..64].fill(0xff);
    cases.push(("s_7fff_ff", low_high_byte));
    let mut v2_high = at_half;
    v2_high[63] += 1;
    v2_high[64] = 2;
    cases.push(("v2_and_high_s", v2_high));
    for (name, b) in cases {
        let res = EcdsaSignature::from_bytes(&b);
        let result = match &res {
            Ok(s) => {
                assert_eq!(s.as_fixed_bytes()[..64], b[..64]);
                vec![0, s.recovery_id]
            }
            Err(e) => vec![ecdsa_error_code(*e), 0],
        };
        if res.is_ok() {
            g.ok(&format!("from_bytes_{name}"), b);
        } else {
            g.0.insert(
                format!("from_bytes_{name}"),
                serde_json::json!({"hex": super::hex(&b), "ok": false}),
            );
        }
        g.ok(&format!("from_bytes_{name}_result"), result);
    }

    // eth_signed_message_hash: input || output.
    for (name, h) in [
        ("zero", H256::zero()),
        ("seq", H256::from(seq32(1))),
        (
            "f0f",
            H256::from_str("0xf00000000000000000000000000000000000000000000000000000000000000f")
                .unwrap(),
        ),
    ] {
        let mut b = h.as_bytes().to_vec();
        b.extend_from_slice(Payload(h).eth_signed_message_hash().as_bytes());
        g.ok(&format!("eth_signed_{name}"), b);
    }

    // multisig-ism's library test signature (0xfdB6...15bD over f0..0f).
    let digest = Payload(
        H256::from_str("0xf00000000000000000000000000000000000000000000000000000000000000f")
            .unwrap(),
    )
    .eth_signed_message_hash();
    let sig = unhex("4e561dcd350b7a271c7247843f7731a8a9810037c13784f5b3a9616788ca536976c5ff70b1865c4568e273a375851a5304dc7a1ac54f0783f3dde38d345313a91c");
    let a = recover(&mut g, "lib_test", digest.as_fixed_bytes(), &sig);
    assert_eq!(
        a,
        H160::from_str("0xfdB65576568b99A8a00a292577b8fc51abB115bD").unwrap()
    );
    g
}

fn multisig_error_code(e: MultisigIsmError) -> u8 {
    match e {
        MultisigIsmError::InvalidSignature => 1,
        MultisigIsmError::ThresholdNotMet => 2,
        MultisigIsmError::InvalidMetadata => 3,
    }
}

fn multisig_group() -> Group {
    let mut g = Group::new();
    let d = get_multisig_ism_test_data();
    g.ok("test_data_message", d.message.to_vec());
    g.ok("test_data_message_id", d.message.id().as_bytes().to_vec());
    let cp = &d.checkpoint;
    // checkpoint fields: hook(32) || domain(u32 BE) || root(32) || index(u32 BE) || id(32)
    let mut fields = cp.merkle_tree_hook_address.as_bytes().to_vec();
    fields.extend_from_slice(&cp.mailbox_domain.to_be_bytes());
    fields.extend_from_slice(cp.root.as_bytes());
    fields.extend_from_slice(&cp.index.to_be_bytes());
    fields.extend_from_slice(cp.message_id.as_bytes());
    g.ok("test_data_checkpoint_fields", fields);
    g.ok(
        "test_data_signing_hash",
        cp.signing_hash().as_bytes().to_vec(),
    );
    let digest = cp.eth_signed_message_hash();
    g.ok("test_data_eth_signed_hash", digest.as_bytes().to_vec());
    let mut vals = vec![];
    for v in &d.validators {
        vals.extend_from_slice(v.as_bytes());
    }
    g.ok("test_data_validators", vals);
    let non_validator = unhex("c75dca903d963f30f169ba99c2554572108474c097bd40c2a29fbcf4739fdb564e795fce8e0ae3b860dfd4e0b3f93420ccb6454e87fa3235c8754a5437a78f781b");
    let mut sigs = d.signatures.clone();
    sigs.push(non_validator);
    for (i, s) in sigs.iter().enumerate() {
        g.ok(&format!("test_data_signature_{i}"), s.clone());
        let a = recover(
            &mut g,
            &format!("test_data_{i}"),
            digest.as_fixed_bytes(),
            s,
        );
        if i < 3 {
            assert_eq!(a, d.validators[i]);
        }
    }
    // Same signatures over the checkpoint of a message with nonce 420.
    let other = HyperlaneMessage {
        nonce: 420,
        ..d.message.clone()
    };
    g.ok("test_data_message_nonce_420", other.to_vec());
    let other_digest = CheckpointWithMessageId {
        checkpoint: cp.checkpoint,
        message_id: other.id(),
    }
    .eth_signed_message_hash();
    g.ok(
        "test_data_nonce_420_eth_signed_hash",
        other_digest.as_bytes().to_vec(),
    );
    for i in 0..2 {
        recover(
            &mut g,
            &format!("test_data_nonce_420_{i}"),
            other_digest.as_fixed_bytes(),
            &sigs[i],
        );
    }

    // Metadata encodings: Encode and TryFrom<Vec<u8>> acceptance.
    let meta = |idx: &[usize]| MultisigIsmMessageIdMetadata {
        origin_merkle_tree_hook: cp.merkle_tree_hook_address,
        merkle_root: cp.root,
        merkle_index: cp.index,
        validator_signatures: idx
            .iter()
            .map(|&i| EcdsaSignature::from_bytes(&sigs[i]).unwrap())
            .collect(),
    };
    g.ok("metadata_sigs_0_1", meta(&[0, 1]).to_vec());
    g.ok("metadata_sigs_0_2_3", meta(&[0, 2, 3]).to_vec());
    let full = meta(&[0, 1]).to_vec();
    let mut bad: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("no_signatures", full[..68].to_vec()),
        ("short_signature", full[..68 + 64].to_vec()),
        ("trailing_byte", [&full[..], &[0u8]].concat()),
    ];
    let mut high_s = full.clone();
    high_s[68 + 65 + 32..68 + 65 + 64].fill(0xff);
    bad.push(("second_sig_high_s", high_s));
    let mut bad_v = full.clone();
    bad_v[68 + 64] = 5;
    bad.push(("first_sig_bad_v", bad_v));
    for (name, b) in bad {
        assert!(MultisigIsmMessageIdMetadata::try_from(b.clone()).is_err());
        g.0.insert(
            format!("metadata_reject_{name}"),
            serde_json::json!({"hex": super::hex(&b), "ok": false}),
        );
    }

    // MultisigIsm::verify over the test-data checkpoint: "verify_<case>" is
    // [signature indices..., threshold] -> "verify_<case>_result" [code].
    for (name, idx, threshold) in [
        ("ok_0_1", vec![0usize, 1], 2u8),
        ("ok_0_2_nonvalidator", vec![0, 2, 3], 2),
        ("ok_1_2", vec![1, 2], 2),
        ("ok_threshold_1", vec![2], 1),
        ("out_of_order", vec![1, 0], 2),
        ("duplicate", vec![0, 0], 2),
        ("too_few", vec![0], 2),
        ("nonvalidator_first", vec![3, 0, 1], 2),
        ("all_three", vec![0, 1, 2], 3),
        ("threshold_0_no_sigs", vec![], 0),
    ] {
        let ism = MultisigIsm::new(
            cp.clone(),
            idx.iter()
                .map(|&i| EcdsaSignature::from_bytes(&sigs[i]).unwrap())
                .collect(),
            d.validators.clone(),
            threshold,
        );
        let code = match ism.verify() {
            Ok(()) => 0,
            Err(e) => multisig_error_code(e),
        };
        let mut b: Vec<u8> = idx.iter().map(|&i| i as u8).collect();
        b.push(threshold);
        g.ok(&format!("verify_{name}"), b);
        g.ok(&format!("verify_{name}_result"), vec![code]);
    }

    g.ok(
        "ix_validators_and_threshold",
        MultisigIsmInstruction::ValidatorsAndThreshold(d.message.to_vec())
            .encode()
            .unwrap(),
    );
    g.ok(
        "ix_validators_and_threshold_account_metas",
        MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(vec![1, 2, 3])
            .encode()
            .unwrap(),
    );
    g.borsh(
        "validators_and_threshold",
        &multisig_ism::ValidatorsAndThreshold {
            validators: d.validators.clone(),
            threshold: 2,
        },
    );
    g
}

fn quote_validation_code(r: Result<(), QuoteValidationError>) -> u32 {
    match r {
        Ok(()) => 0,
        Err(e) => e as u32,
    }
}

fn quote_group() -> Group {
    let mut g = Group::new();
    let key = SigningKey::from_slice(&seq32(0x40)).unwrap();
    let fee_account = Pubkey::new_from_array(seq32(1));
    let payer = Pubkey::new_from_array(seq32(2));
    let other_payer = Pubkey::new_from_array(seq32(3));
    let domain = 42u32;
    let mut quote = SvmSignedQuote {
        context: vec![1, 2, 3],
        data: vec![4, 5, 6, 7],
        issued_at: [0, 0, 0x65, 0, 0, 1],
        expiry: [0, 0, 0x65, 0, 0x0e, 0x11],
        client_salt: H256::from(seq32(0x80)),
        signature: [0u8; 65],
    };
    let scoped = quote.compute_scoped_salt(&payer);
    let hash = quote.build_message_hash(&fee_account, domain, &scoped);
    let (sig, rid) = key.sign_prehash_recoverable(hash.as_bytes()).unwrap();
    quote.signature[..64].copy_from_slice(&sig.to_bytes());
    quote.signature[64] = rid.to_byte();
    // Low-S normalized by k256; the library rejects high-S.
    EcdsaSignature::from_bytes(&quote.signature).unwrap();

    g.borsh("quote", &quote);
    g.ok("fee_account", fee_account.to_bytes().to_vec());
    g.ok("payer", payer.to_bytes().to_vec());
    g.ok("other_payer", other_payer.to_bytes().to_vec());
    g.ok("scoped_salt", scoped.as_bytes().to_vec());
    g.ok("message_hash", hash.as_bytes().to_vec());
    let signer = recover(&mut g, "quote", hash.as_fixed_bytes(), &quote.signature);
    let other_scoped = quote.compute_scoped_salt(&other_payer);
    let other_hash = quote.build_message_hash(&fee_account, domain, &other_scoped);
    recover(
        &mut g,
        "quote_other_payer",
        other_hash.as_fixed_bytes(),
        &quote.signature,
    );
    g.ok("message_hash_domain_43", {
        quote
            .build_message_hash(&fee_account, 43, &scoped)
            .as_bytes()
            .to_vec()
    });
    let empty = SvmSignedQuote {
        context: vec![],
        data: vec![],
        ..quote.clone()
    };
    g.borsh("quote_empty_vecs", &empty);
    g.ok(
        "message_hash_empty_vecs",
        empty
            .build_message_hash(&fee_account, domain, &scoped)
            .as_bytes()
            .to_vec(),
    );

    // verify_signer outcomes: [code u32 LE].
    let one: BTreeSet<H160> = [signer].into_iter().collect();
    let other: BTreeSet<H160> = [H160::from(seq20(9))].into_iter().collect();
    let two: BTreeSet<H160> = [H160::from(seq20(9)), signer].into_iter().collect();
    let verify_code = |q: &SvmSignedQuote, p: &Pubkey, d: u32, set: &BTreeSet<H160>| -> u32 {
        match q.verify_signer(&fee_account, d, p, set) {
            Ok(a) => {
                assert_eq!(a, signer);
                0
            }
            Err(e) => {
                let e: QuoteVerifyError = e;
                e as u32
            }
        }
    };
    let mut zero_sig = quote.clone();
    zero_sig.signature = [0u8; 65];
    let mut high_s = quote.clone();
    high_s.signature[32..64].fill(0xff);
    for (name, code) in [
        ("ok", verify_code(&quote, &payer, domain, &one)),
        ("ok_two_signers", verify_code(&quote, &payer, domain, &two)),
        (
            "empty_set",
            verify_code(&quote, &payer, domain, &BTreeSet::new()),
        ),
        ("unauthorized", verify_code(&quote, &payer, domain, &other)),
        (
            "wrong_payer",
            verify_code(&quote, &other_payer, domain, &one),
        ),
        (
            "zero_signature",
            verify_code(&zero_sig, &payer, domain, &one),
        ),
        ("high_s", verify_code(&high_s, &payer, domain, &one)),
        (
            "empty_set_bad_signature",
            verify_code(&zero_sig, &payer, domain, &BTreeSet::new()),
        ),
    ] {
        g.ok(&format!("verify_{name}"), code.to_le_bytes().to_vec());
    }
    let mut set_bytes = vec![];
    for a in &one {
        set_bytes.extend_from_slice(a.as_bytes());
    }
    g.ok("signer", set_bytes);

    // Validation grid: issued_at, expiry (u48 BE), min_issued_at, now (i64
    // LE) -> validate_quote code, validate_quote_submission code (u32 LE).
    let mut grid = vec![];
    for issued in [0i64, 100, 1000, 1300, 1301, (1 << 48) - 1] {
        for expiry in [0i64, 100, 999, 1000, 2000, (1 << 48) - 1] {
            for min in [0i64, 100, 1001] {
                for now in [0i64, 999, 1000, 1001, 5000] {
                    let mut q = quote.clone();
                    q.issued_at.copy_from_slice(&issued.to_be_bytes()[2..]);
                    q.expiry.copy_from_slice(&expiry.to_be_bytes()[2..]);
                    let clock = Clock {
                        unix_timestamp: now,
                        ..Clock::default()
                    };
                    grid.extend_from_slice(&q.issued_at);
                    grid.extend_from_slice(&q.expiry);
                    grid.extend_from_slice(&min.to_le_bytes());
                    grid.extend_from_slice(&now.to_le_bytes());
                    grid.extend_from_slice(
                        &quote_validation_code(q.validate_quote(min, &clock)).to_le_bytes(),
                    );
                    grid.extend_from_slice(
                        &quote_validation_code(q.validate_quote_submission(min, &clock))
                            .to_le_bytes(),
                    );
                }
            }
        }
    }
    g.ok("validation_grid", grid);
    g.ok(
        "keccak_payer_salt",
        keccak::hashv(&[payer.as_ref(), quote.client_salt.as_bytes()])
            .to_bytes()
            .to_vec(),
    );
    g
}

fn validator_announce_group() -> Group {
    let mut g = Group::new();
    let mailbox =
        H256::from_str("0x00000000000000000000000035231d4c2d8b8adcb5617a638a0c4548684c7c70")
            .unwrap();
    let validator = H160::from_str("0x13DFDeB827D4D7fACE707fAdbfd4D651438B4aB3").unwrap();
    let fixtures = [
        (
            "s3://test-storage-location-foo/us-east-1",
            "fa0d375457d9a98b3cd6c6ee308464ea23abc2f2368e80d942dacf0b2e3cc4d66ac51efabe169b7cb29170894c588221c91807e500a7a9f9648a8b1c47eceecc1c",
            validator,
            mailbox,
            1u32,
        ),
        (
            "s3://test-storage-location-Здравствуйте/us-east-1",
            "983b941ae9bf939bf59abcf81e7d2e66735da5e2726f955b915aea247ae16afa3a03b69fe7d7c83154caca29d8ad62f2a1ccbbb5c56f67dab10c98a2d4aac3b01c",
            validator,
            mailbox,
            1u32,
        ),
        (
            "s3://hyperlane-mainnet2-ethereum-validator-0/us-east-1",
            "20ac937917284eaa3d67287278fc51875874241fffab5eb5fd8ae899a7074c5679be15f0bdb5b4f7594cefc5cba17df59b68ba3c55836053a23307db5a95610d1b",
            H160::from_str("0x4c327ccb881a7542be77500b2833dc84c839e7b7").unwrap(),
            mailbox,
            1u32,
        ),
    ];
    for (i, (location, sig, validator, mailbox, domain)) in fixtures.iter().enumerate() {
        let announcement = Announcement {
            validator: *validator,
            mailbox_address: *mailbox,
            mailbox_domain: *domain,
            storage_location: location.to_string(),
        };
        g.ok(
            &format!("announcement_{i}_signing_hash"),
            announcement.signing_hash().as_bytes().to_vec(),
        );
        let digest = announcement.eth_signed_message_hash();
        g.ok(
            &format!("announcement_{i}_eth_signed_hash"),
            digest.as_bytes().to_vec(),
        );
        let sig = unhex(sig);
        let a = recover(
            &mut g,
            &format!("announcement_{i}"),
            digest.as_fixed_bytes(),
            &sig,
        );
        assert_eq!(a, *validator);
        let ix = AnnounceInstruction {
            validator: *validator,
            storage_location: location.to_string(),
            signature: sig,
        };
        g.ok(
            &format!("announcement_{i}_replay_id"),
            ix.replay_id().to_vec(),
        );
        g.borsh(&format!("ix_announce_{i}"), &VaInstruction::Announce(ix));
    }
    // Same signature with domain 2: recovers someone else.
    let wrong = Announcement {
        validator: fixtures[2].2,
        mailbox_address: mailbox,
        mailbox_domain: 2,
        storage_location: fixtures[2].0.to_string(),
    }
    .eth_signed_message_hash();
    g.ok(
        "announcement_2_domain_2_eth_signed_hash",
        wrong.as_bytes().to_vec(),
    );
    recover(
        &mut g,
        "announcement_2_domain_2",
        wrong.as_fixed_bytes(),
        &unhex(fixtures[2].1),
    );

    g.borsh(
        "ix_init",
        &VaInstruction::Init(InitInstruction {
            mailbox: Pubkey::new_from_array(mailbox.0),
            local_domain: 1,
        }),
    );
    g.reject::<VaInstruction>("ix_reject_tag_2", vec![2]);
    g.reject::<VaInstruction>("ix_reject_trailing", {
        let mut b = borsh::to_vec(&VaInstruction::Init(InitInstruction {
            mailbox: Pubkey::new_from_array(mailbox.0),
            local_domain: 1,
        }))
        .unwrap();
        b.push(0);
        b
    });
    g.reject::<VaInstruction>("ix_reject_bad_utf8", {
        let mut b = vec![1u8];
        b.extend_from_slice(&seq20(1));
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&[0xc3, 0x28]);
        b.extend_from_slice(&0u32.to_le_bytes());
        b
    });
    let va = ValidatorAnnounce {
        bump_seed: 253,
        mailbox: Pubkey::new_from_array(mailbox.0),
        local_domain: 1,
    };
    assert_eq!(va.size(), 37);
    g.ok("account_validator_announce", account(va));
    let locs = ValidatorStorageLocations {
        bump_seed: 254,
        storage_locations: vec![fixtures[0].0.to_string(), fixtures[1].0.to_string()],
    };
    g.ok("account_storage_locations", account(locs));
    g.ok("account_replay_protection", account(ReplayProtection(())));
    g
}

fn multisig_program_group() -> Group {
    let mut g = Group::new();
    let ixs: Vec<(&str, MultisigProgramInstruction)> = vec![
        ("ix_initialize", MultisigProgramInstruction::Initialize),
        (
            "ix_set_validators_and_threshold",
            MultisigProgramInstruction::SetValidatorsAndThreshold(Domained {
                domain: 1234,
                data: ValidatorsAndThreshold {
                    validators: vec![H160::from(seq20(1)), H160::from(seq20(2))],
                    threshold: 2,
                },
            }),
        ),
        ("ix_get_owner", MultisigProgramInstruction::GetOwner),
        (
            "ix_transfer_ownership_some",
            MultisigProgramInstruction::TransferOwnership(Some(Pubkey::new_from_array(seq32(7)))),
        ),
        (
            "ix_transfer_ownership_none",
            MultisigProgramInstruction::TransferOwnership(None),
        ),
    ];
    for (name, ix) in ixs {
        g.ok(name, ix.encode().unwrap());
    }
    let ac = AccessControlData {
        bump_seed: 250,
        owner: Some(Pubkey::new_from_array(seq32(7))),
    };
    assert_eq!(ac.size(), 34);
    g.ok("account_access_control", account(ac));
    g.ok(
        "account_access_control_none",
        account(AccessControlData {
            bump_seed: 250,
            owner: None,
        }),
    );
    g.ok(
        "account_domain_data",
        account(DomainData {
            bump_seed: 255,
            validators_and_threshold: ValidatorsAndThreshold {
                validators: vec![H160::from(seq20(1)), H160::from(seq20(2))],
                threshold: 1,
            },
        }),
    );
    for (name, v, ok) in [
        ("validate_ok", vec![seq20(1), seq20(2)], 1u8),
        ("validate_threshold_eq_len", vec![seq20(1), seq20(2)], 2),
        ("validate_zero", vec![seq20(1)], 0),
        ("validate_empty", vec![], 0),
        ("validate_exceeds", vec![seq20(1)], 2),
        ("validate_duplicate", vec![seq20(1), seq20(2), seq20(1)], 2),
    ] {
        let vt = ValidatorsAndThreshold {
            validators: v.into_iter().map(H160::from).collect(),
            threshold: ok,
        };
        let r = vt.validate().is_ok() as u8;
        g.ok(name, [borsh::to_vec(&vt).unwrap(), vec![r]].concat());
    }
    g
}

/// Inserts this module's groups into the top-level vector object.
pub fn extend(out: &mut Value) {
    let o: &mut Map<String, Value> = out.as_object_mut().unwrap();
    for (name, g) in [
        ("ecdsa-signature", ecdsa_group()),
        ("multisig-ism", multisig_group()),
        ("quote-verifier", quote_group()),
        ("validator-announce", validator_announce_group()),
        ("multisig-ism-message-id", multisig_program_group()),
    ] {
        o.insert(name.into(), Value::Object(g.0));
    }
}
