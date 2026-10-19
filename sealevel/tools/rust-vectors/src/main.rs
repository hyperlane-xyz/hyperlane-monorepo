//! Prints JSON vectors: `{"<name>": {"hex": "...", "ok": bool}}` grouped by
//! Go package. `ok: false` marks input the Rust decoder rejects.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use account_utils::{
    AccountData, DiscriminatorData, DiscriminatorPrefixed, OptionalDiscriminatedData,
};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Encode, HyperlaneMessage, H160, H256, U256};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, MetadataSpec, MetadataSpecResult, VerifyInstruction,
    VerifyMetadataSpecInstruction,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_test_ism::program::{TestIsmInstruction, TestIsmStorage};
use hyperlane_warp_route::TokenMessage;
use serde_json::{json, Map, Value};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::pubkey::Pubkey;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn seq32(start: u8) -> [u8; 32] {
    std::array::from_fn(|i| start.wrapping_add(i as u8))
}

fn seq20(start: u8) -> [u8; 20] {
    std::array::from_fn(|i| start.wrapping_add(i as u8))
}

struct Group(Map<String, Value>);

impl Group {
    fn new() -> Self {
        Self(Map::new())
    }
    fn ok(&mut self, name: &str, bytes: Vec<u8>) {
        self.0
            .insert(name.into(), json!({"hex": hex(&bytes), "ok": true}));
    }
    fn borsh<T: BorshSerialize + BorshDeserialize>(&mut self, name: &str, v: &T) {
        let bytes = borsh::to_vec(v).unwrap();
        // Round-trip through the Rust decoder too.
        let back = T::try_from_slice(&bytes).unwrap();
        assert_eq!(borsh::to_vec(&back).unwrap(), bytes, "{name}");
        self.ok(name, bytes);
    }
    /// Records bytes the Rust decoder for T rejects (try_from_slice).
    fn reject<T: BorshDeserialize>(&mut self, name: &str, bytes: Vec<u8>) {
        assert!(
            T::try_from_slice(&bytes).is_err(),
            "{name} unexpectedly decodes"
        );
        self.0
            .insert(name.into(), json!({"hex": hex(&bytes), "ok": false}));
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
enum Sample {
    Unit,
    Tuple(u32, bool),
    Struct {
        a: u8,
        b: Vec<u8>,
        c: Option<Pubkey>,
    },
}

#[derive(BorshSerialize, BorshDeserialize, Default, Debug, PartialEq)]
struct Foo {
    a: u64,
}
impl DiscriminatorData for Foo {
    const DISCRIMINATOR: [u8; 8] = [2, 2, 2, 2, 2, 2, 2, 2];
}

#[derive(BorshSerialize, BorshDeserialize, Default, Debug, PartialEq)]
struct WithTail {
    a: u32,
    tail: OptionalDiscriminatedData<Foo>,
}

fn borsh_group() -> Group {
    let mut g = Group::new();
    g.borsh("u8_0", &0u8);
    g.borsh("u8_max", &u8::MAX);
    g.borsh("u16", &0x1234u16);
    g.borsh("u32", &0xdead_beefu32);
    g.borsh("u64_max", &u64::MAX);
    g.borsh("u64_1", &1u64);
    g.borsh("u128", &((1u128 << 64) + 2));
    g.borsh("u128_max", &u128::MAX);
    g.borsh("i8", &-1i8);
    g.borsh("i16", &-2i16);
    g.borsh("i32", &-3i32);
    g.borsh("i64_min", &i64::MIN);
    g.borsh("bool_true", &true);
    g.borsh("bool_false", &false);
    g.borsh(
        "u256",
        &U256::from_dec_str(
            "115792089237316195423570985008687907853269984665640564039457584007913129639935",
        )
        .unwrap(),
    );
    g.borsh(
        "u256_mid",
        &U256::from_dec_str("340282366920938463463374607431768211457").unwrap(),
    );
    g.borsh("h256", &H256::from(seq32(1)));
    g.borsh("h160", &H160::from(seq20(1)));
    g.borsh("pubkey", &Pubkey::new_from_array(seq32(100)));
    g.borsh("vec_u8_empty", &Vec::<u8>::new());
    g.borsh("vec_u8", &vec![1u8, 2, 3]);
    g.borsh("vec_u32", &vec![1u32, 2]);
    g.borsh(
        "vec_pubkey",
        &vec![
            Pubkey::new_from_array(seq32(1)),
            Pubkey::new_from_array(seq32(2)),
        ],
    );
    g.borsh("string_empty", &String::new());
    g.borsh("string", &"hyperlane".to_string());
    g.borsh("string_utf8", &"é✓".to_string());
    g.borsh("option_none", &Option::<u64>::None);
    g.borsh("option_some", &Some(7u64));
    g.borsh("option_pubkey", &Some(Pubkey::new_from_array(seq32(9))));
    g.borsh("array_u8_4", &[9u8, 8, 7, 6]);
    g.borsh("array_u64_2", &[1u64, u64::MAX]);
    g.borsh("tuple", &(5u8, 6u32));
    g.borsh("enum_unit", &Sample::Unit);
    g.borsh("enum_tuple", &Sample::Tuple(77, true));
    g.borsh(
        "enum_struct",
        &Sample::Struct {
            a: 1,
            b: vec![2, 3],
            c: Some(Pubkey::new_from_array(seq32(4))),
        },
    );
    let mut m = HashMap::new();
    m.insert(3u32, 30u64);
    m.insert(1u32, 10u64);
    m.insert(2u32, 20u64);
    g.borsh("hashmap_u32_u64", &m);
    let mut bm = BTreeMap::new();
    bm.insert(H256::from(seq32(5)), 1u8);
    bm.insert(H256::from(seq32(1)), 2u8);
    g.borsh("btreemap_h256_u8", &bm);
    let s: BTreeSet<H160> = [H160::from(seq20(9)), H160::from(seq20(1))]
        .into_iter()
        .collect();
    g.borsh("btreeset_h160", &s);

    // Map input that is unsorted with a repeated key: accepted, last value wins.
    let unsorted: Vec<(u32, u64)> = vec![(2, 1), (1, 5), (2, 9)];
    let bytes = borsh::to_vec(&unsorted).unwrap();
    let decoded = HashMap::<u32, u64>::try_from_slice(&bytes).unwrap();
    g.ok("hashmap_unsorted_input", bytes);
    g.borsh("hashmap_unsorted_canonical", &decoded);

    g.reject::<bool>("reject_bool_2", vec![2]);
    g.reject::<Option<u8>>("reject_option_tag_2", vec![2, 0]);
    g.reject::<String>("reject_string_utf8", vec![2, 0, 0, 0, 0xff, 0xfe]);
    g.reject::<Vec<u8>>("reject_vec_short", vec![4, 0, 0, 0, 1, 2]);
    g.reject::<u64>("reject_u64_short", vec![1, 2, 3]);
    g.reject::<u32>("reject_trailing", vec![1, 0, 0, 0, 0]);
    g.reject::<Sample>("reject_enum_variant", vec![3]);
    g
}

fn account_utils_group() -> Group {
    let mut g = Group::new();
    let storage = AccountData::from(TestIsmStorage { accept: true });
    let mut buf = vec![0xffu8; 4];
    storage.store_in_slice(&mut buf).unwrap();
    g.ok("account_data_store_in_slice_zeroes_tail", buf);
    g.ok("account_data_test_ism_rejecting", {
        let mut b = vec![0u8; 2];
        AccountData::from(TestIsmStorage { accept: false })
            .store_in_slice(&mut b)
            .unwrap();
        b
    });
    g.borsh(
        "discriminator_prefixed_foo",
        &DiscriminatorPrefixed::new(Foo { a: 1 }),
    );
    g.reject::<DiscriminatorPrefixed<Foo>>("reject_discriminator_mismatch", {
        let mut b = vec![3u8; 8];
        b.extend_from_slice(&1u64.to_le_bytes());
        b
    });
    g.borsh(
        "optional_discriminated_some",
        &WithTail {
            a: 5,
            tail: Some(Foo { a: 7 }).into(),
        },
    );
    g.borsh(
        "optional_discriminated_none",
        &WithTail {
            a: 5,
            tail: None.into(),
        },
    );
    // Reader-based decode (AccountData::fetch path) of stale and short tails.
    for (name, tail) in [
        ("optional_discriminated_stale_tail", vec![0xffu8; 16]),
        ("optional_discriminated_short_tail", vec![2u8, 2]),
    ] {
        let mut b = 5u32.to_le_bytes().to_vec();
        b.extend_from_slice(&tail);
        let v = WithTail::deserialize(&mut &b[..]).unwrap();
        assert_eq!(v.tail, None);
        g.ok(name, b);
    }
    g
}

fn interfaces_group() -> Group {
    let mut g = Group::new();
    g.ok(
        "ism_type",
        InterchainSecurityModuleInstruction::Type.encode().unwrap(),
    );
    g.ok(
        "ism_verify",
        InterchainSecurityModuleInstruction::Verify(VerifyInstruction::new(
            vec![5, 4, 3, 2, 1],
            vec![1, 2, 3, 4, 5],
        ))
        .encode()
        .unwrap(),
    );
    g.ok(
        "ism_verify_account_metas",
        InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction::new(
            vec![],
            vec![9],
        ))
        .encode()
        .unwrap(),
    );
    g.ok(
        "ism_verify_metadata_spec",
        InterchainSecurityModuleInstruction::VerifyMetadataSpec(
            VerifyMetadataSpecInstruction::new(vec![1, 2, 3]),
        )
        .encode()
        .unwrap(),
    );
    let nested = MetadataSpecResult {
        spec: Some(MetadataSpec::Aggregation {
            threshold: 2,
            sub_specs: vec![
                MetadataSpec::Null,
                MetadataSpec::Aggregation {
                    threshold: 1,
                    sub_specs: vec![
                        MetadataSpec::TrustedRelayer {
                            relayer: Pubkey::new_from_array(seq32(7)),
                        },
                        MetadataSpec::Aggregation {
                            threshold: 0,
                            sub_specs: vec![],
                        },
                    ],
                },
                MetadataSpec::MultisigMessageId {
                    validators: vec![H160::from(seq20(1)), H160::from(seq20(2))],
                    threshold: 2,
                },
                MetadataSpec::CannotVerify,
            ],
        }),
        accounts: vec![Pubkey::new_from_array(seq32(3))],
    };
    g.borsh("metadata_spec_result_nested", &nested);
    g.borsh(
        "metadata_spec_result_null",
        &MetadataSpecResult {
            spec: Some(MetadataSpec::Null),
            accounts: vec![],
        },
    );
    g.borsh(
        "simulation_return_data_metadata_spec_null",
        &SimulationReturnData::new(MetadataSpecResult {
            spec: Some(MetadataSpec::Null),
            accounts: vec![],
        }),
    );
    g.borsh(
        "simulation_return_data_u32",
        &SimulationReturnData::new(0u32),
    );
    g.borsh(
        "simulation_return_data_metas",
        &SimulationReturnData::new(vec![
            SerializableAccountMeta {
                pubkey: Pubkey::new_from_array(seq32(1)),
                is_signer: false,
                is_writable: false,
            },
            SerializableAccountMeta {
                pubkey: Pubkey::new_from_array(seq32(2)),
                is_signer: true,
                is_writable: true,
            },
        ]),
    );
    g.ok(
        "recipient_ism",
        MessageRecipientInstruction::InterchainSecurityModule
            .encode()
            .unwrap(),
    );
    g.ok(
        "recipient_ism_account_metas",
        MessageRecipientInstruction::InterchainSecurityModuleAccountMetas
            .encode()
            .unwrap(),
    );
    g.ok(
        "recipient_handle",
        MessageRecipientInstruction::Handle(HandleInstruction::new(
            69,
            H256::from(seq32(1)),
            vec![1, 2, 3, 4, 5],
        ))
        .encode()
        .unwrap(),
    );
    g.ok(
        "recipient_handle_account_metas",
        MessageRecipientInstruction::HandleAccountMetas(HandleInstruction::new(
            u32::MAX,
            H256::from(seq32(2)),
            vec![],
        ))
        .encode()
        .unwrap(),
    );
    g.borsh("test_ism_init", &TestIsmInstruction::Init);
    g.borsh(
        "test_ism_set_accept_true",
        &TestIsmInstruction::SetAccept(true),
    );
    g.borsh(
        "test_ism_set_accept_false",
        &TestIsmInstruction::SetAccept(false),
    );
    g
}

fn core_group() -> Group {
    let mut g = Group::new();
    let mut sender = [0u8; 32];
    sender[12..].fill(0x11);
    let mut recipient = [0u8; 32];
    recipient[12..].fill(0x22);
    let m = HyperlaneMessage {
        version: 3,
        nonce: 0,
        origin: 1000,
        sender: sender.into(),
        destination: 2000,
        recipient: recipient.into(),
        body: vec![0x12, 0x34],
    };
    g.ok("message_vectors_json", m.to_vec());
    let m2 = HyperlaneMessage {
        version: 3,
        nonce: u32::MAX,
        origin: 0x0102_0304,
        sender: H256::from(seq32(1)),
        destination: 0xa0b0_c0d0,
        recipient: H256::from(seq32(100)),
        body: vec![],
    };
    g.ok("message_empty_body", m2.to_vec());
    let t = TokenMessage::new(
        H256::from(seq32(1)),
        U256::from_dec_str("340282366920938463463374607431768211457").unwrap(),
        vec![],
    );
    g.ok("token_message", t.to_vec());
    let t2 = TokenMessage::new(
        H256::from(seq32(2)),
        U256::MAX - U256::from(1u8),
        vec![9, 9],
    );
    g.ok("token_message_metadata", t2.to_vec());
    g
}

fn svm_group() -> Group {
    use solana_program::program_error::ProgramError;
    use solana_system_interface::instruction as system;
    let mut g = Group::new();
    let a = Pubkey::new_from_array(seq32(1));
    let b = Pubkey::new_from_array(seq32(2));
    let owner = Pubkey::new_from_array(seq32(3));
    g.ok(
        "system_create_account",
        system::create_account(&a, &b, 904_800, 2, &owner).data,
    );
    g.ok("system_transfer", system::transfer(&a, &b, u64::MAX).data);
    g.ok("system_allocate", system::allocate(&b, 10_240).data);
    g.ok("system_assign", system::assign(&b, &owner).data);
    for (name, e) in [
        ("InvalidArgument", ProgramError::InvalidArgument),
        (
            "InvalidInstructionData",
            ProgramError::InvalidInstructionData,
        ),
        ("InvalidAccountData", ProgramError::InvalidAccountData),
        ("AccountDataTooSmall", ProgramError::AccountDataTooSmall),
        ("InsufficientFunds", ProgramError::InsufficientFunds),
        ("IncorrectProgramId", ProgramError::IncorrectProgramId),
        (
            "MissingRequiredSignature",
            ProgramError::MissingRequiredSignature,
        ),
        (
            "AccountAlreadyInitialized",
            ProgramError::AccountAlreadyInitialized,
        ),
        ("UninitializedAccount", ProgramError::UninitializedAccount),
        ("NotEnoughAccountKeys", ProgramError::NotEnoughAccountKeys),
        ("AccountBorrowFailed", ProgramError::AccountBorrowFailed),
        ("MaxSeedLengthExceeded", ProgramError::MaxSeedLengthExceeded),
        ("InvalidSeeds", ProgramError::InvalidSeeds),
        ("BorshIoError", ProgramError::BorshIoError),
        ("AccountNotRentExempt", ProgramError::AccountNotRentExempt),
        ("UnsupportedSysvar", ProgramError::UnsupportedSysvar),
        ("IllegalOwner", ProgramError::IllegalOwner),
        (
            "MaxAccountsDataAllocationsExceeded",
            ProgramError::MaxAccountsDataAllocationsExceeded,
        ),
        ("InvalidRealloc", ProgramError::InvalidRealloc),
        (
            "MaxInstructionTraceLengthExceeded",
            ProgramError::MaxInstructionTraceLengthExceeded,
        ),
        (
            "BuiltinProgramsMustConsumeComputeUnits",
            ProgramError::BuiltinProgramsMustConsumeComputeUnits,
        ),
        ("InvalidAccountOwner", ProgramError::InvalidAccountOwner),
        ("ArithmeticOverflow", ProgramError::ArithmeticOverflow),
        ("Immutable", ProgramError::Immutable),
        ("IncorrectAuthority", ProgramError::IncorrectAuthority),
        ("Custom0", ProgramError::Custom(0)),
        ("Custom69420", ProgramError::Custom(69420)),
    ] {
        g.ok(
            &format!("error_{name}"),
            u64::from(e).to_le_bytes().to_vec(),
        );
    }
    g
}

fn composite_seq_key(i: usize) -> Pubkey {
    Pubkey::new_from_array(seq32(i as u8))
}

/// Trees shared with programs/ism/composite-ism's Go tests (same builders).
fn composite_deep(depth: usize) -> composite::IsmNode {
    let mut node = composite::IsmNode::Test { accept: true };
    for _ in 0..depth {
        node = composite::IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![node],
        };
    }
    node
}

fn composite_deep_amount(depth: usize) -> composite::IsmNode {
    let mut node = composite::IsmNode::Pausable { paused: true };
    for i in 0..depth {
        node = composite::IsmNode::AmountRouting {
            threshold: U256::from(i as u64) << (i * 7),
            lower: Box::new(node),
            upper: Box::new(composite::IsmNode::TrustedRelayer {
                relayer: composite_seq_key(i),
            }),
        };
    }
    node
}

fn composite_leaf(i: usize) -> composite::IsmNode {
    use composite::IsmNode::*;
    match i % 7 {
        0 => Test { accept: i % 2 == 0 },
        1 => Pausable { paused: i % 3 == 0 },
        2 => TrustedRelayer {
            relayer: composite_seq_key(i),
        },
        3 => MultisigMessageId {
            validators: (0..(i % 5))
                .map(|j| H160::from(seq20((i + j) as u8)))
                .collect(),
            threshold: (i % 4) as u8,
        },
        4 => RateLimited {
            max_capacity: u64::MAX - i as u64,
            recipient: if i % 2 == 0 {
                None
            } else {
                Some(H256::from(seq32(i as u8)))
            },
            filled_level: i as u64 * 1_000,
            last_updated: -(i as i64),
            mailbox: composite_seq_key(i + 1),
        },
        5 => FallbackRouting {
            fallback_ism: composite_seq_key(i + 2),
        },
        _ => Routing,
    }
}

fn composite_wide(width: usize) -> composite::IsmNode {
    composite::IsmNode::Aggregation {
        threshold: (width % 256) as u8,
        sub_isms: (0..width).map(composite_leaf).collect(),
    }
}

/// Wide at every level: Aggregation(fanout) of Aggregation(fanout) of leaves.
fn composite_bushy(depth: usize, fanout: usize) -> composite::IsmNode {
    let mut node = composite_leaf(depth);
    for d in 0..depth {
        let mut subs: Vec<composite::IsmNode> = (0..fanout)
            .map(|j| composite_leaf(d * fanout + j))
            .collect();
        subs[d % fanout] = node;
        subs.push(composite::IsmNode::AmountRouting {
            threshold: U256::MAX,
            lower: Box::new(composite_leaf(d + 3)),
            upper: Box::new(composite::IsmNode::Aggregation {
                threshold: 0,
                sub_isms: vec![],
            }),
        });
        node = composite::IsmNode::Aggregation {
            threshold: d as u8,
            sub_isms: subs,
        };
    }
    node
}

/// AccountData<T> bytes ({initialized: true, T}) via store_in_slice.
fn composite_account<T: BorshSerialize + BorshDeserialize + Default + account_utils::SizedData>(
    v: T,
) -> Vec<u8> {
    let inner = borsh::to_vec(&v).unwrap();
    let mut buf = vec![0xeeu8; inner.len() + 1];
    AccountData::from(v).store_in_slice(&mut buf).unwrap();
    assert_eq!(&buf[1..], &inner[..]);
    buf
}

fn composite_group() -> Group {
    use account_utils::DiscriminatorEncode;
    use composite::{CompositeIsmStorage, DomainIsmStorage, Instruction as Ix, IsmNode};
    let mut g = Group::new();
    let trees: Vec<(&str, IsmNode)> = vec![
        ("deep_16", composite_deep(16)),
        ("deep_200", composite_deep(200)),
        ("deep_amount_40", composite_deep_amount(40)),
        ("wide_50", composite_wide(50)),
        ("wide_300", composite_wide(300)),
        ("bushy_6x5", composite_bushy(6, 5)),
        (
            "empty_aggregation",
            IsmNode::Aggregation {
                threshold: 0,
                sub_isms: vec![],
            },
        ),
        ("routing", IsmNode::Routing),
    ];
    for (name, tree) in &trees {
        g.borsh(&format!("node_{name}"), tree);
    }
    let bushy = composite_bushy(6, 5);
    g.ok(
        "storage_bushy",
        composite_account(CompositeIsmStorage {
            bump_seed: 251,
            owner: Some(composite_seq_key(9)),
            root: Some(bushy.clone()),
        }),
    );
    g.ok(
        "storage_deep_no_owner",
        composite_account(CompositeIsmStorage {
            bump_seed: 1,
            owner: None,
            root: Some(composite_deep(30)),
        }),
    );
    g.ok(
        "domain_storage_wide",
        composite_account(DomainIsmStorage {
            bump_seed: 7,
            domain: u32::MAX,
            ism: Some(composite_wide(40)),
        }),
    );
    g.ok(
        "domain_storage_none",
        composite_account(DomainIsmStorage {
            bump_seed: 7,
            domain: 5,
            ism: None,
        }),
    );
    for (name, ix) in [
        ("initialize_bushy", Ix::Initialize(bushy.clone())),
        (
            "update_config_deep",
            Ix::UpdateConfig(composite_deep_amount(12)),
        ),
        ("get_owner", Ix::GetOwner),
        ("transfer_ownership_none", Ix::TransferOwnership(None)),
        (
            "transfer_ownership_some",
            Ix::TransferOwnership(Some(composite_seq_key(4))),
        ),
        (
            "set_domain_ism_wide",
            Ix::SetDomainIsm {
                domain: 0x01020304,
                ism: composite_wide(20),
            },
        ),
        ("remove_domain_ism", Ix::RemoveDomainIsm { domain: 77 }),
        ("pause", Ix::Pause),
        ("unpause", Ix::Unpause),
    ] {
        g.ok(&format!("ix_{name}"), ix.encode().unwrap());
    }

    // Bytes the Rust decoder rejects.
    let deep = borsh::to_vec(&composite_deep(5)).unwrap();
    g.reject::<IsmNode>("reject_truncated_deep", deep[..deep.len() - 1].to_vec());
    let mut extra_child = deep.clone();
    extra_child[2] = 2; // first Aggregation claims two sub-ISMs
    g.reject::<IsmNode>("reject_missing_child", extra_child);
    g.reject::<IsmNode>("reject_unknown_variant", vec![9]);
    g.reject::<IsmNode>("reject_bad_bool", vec![3, 2]);
    g.reject::<IsmNode>(
        "reject_huge_count",
        vec![2, 1, 0xff, 0xff, 0xff, 0xff, 3, 1],
    );
    g.reject::<IsmNode>("reject_huge_validators", vec![1, 0xff, 0xff, 0xff, 0x0f, 1]);
    let mut rl = borsh::to_vec(&composite_leaf(4)).unwrap();
    rl[9] = 2; // Option<H256> tag
    g.reject::<IsmNode>("reject_bad_option", rl);
    g.reject::<IsmNode>("reject_empty", vec![]);

    // rate_limit::calculate_current_level(filled, last, now, max) as u64 LE.
    for (i, (filled, last, now, max)) in [
        (0u64, 0i64, 86_400i64, 1_000u64),
        (500, 100, 100, 1_000),
        (0, 0, 43_200, 1_000),
        (900, 0, 43_200, 1_000),
        (0, 0, 1, 1),
        (0, 0, 43_200, u64::MAX / 2),
        (u64::MAX, 0, 1, u64::MAX),
        (500, 200, 100, 1_000),
        (2_000, 0, 10, 1_000),
        (12_345, 1_700_000_000, 1_700_050_000, 99_999_999_999),
    ]
    .into_iter()
    .enumerate()
    {
        let mut b = Vec::new();
        for v in [filled, last as u64, now as u64, max] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        let level = composite::calculate_current_level(filled, last, now, max);
        b.extend_from_slice(&level.to_le_bytes());
        g.ok(&format!("rate_level_{i}"), b);
    }
    g
}

mod composite {
    pub use hyperlane_sealevel_composite_ism::accounts::*;
    pub use hyperlane_sealevel_composite_ism::instruction::Instruction;
    pub use hyperlane_sealevel_composite_ism::rate_limit::calculate_current_level;
}

fn main() {
    let out = json!({
        "borsh": Value::Object(borsh_group().0),
        "account-utils": Value::Object(account_utils_group().0),
        "interfaces": Value::Object(interfaces_group().0),
        "hyperlane-core": Value::Object(core_group().0),
        "svm": Value::Object(svm_group().0),
        "composite-ism": Value::Object(composite_group().0),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
