//! msg! formatting vectors: the Display/Debug text Rust logs for the value
//! types the programs print. Each entry is {"hex": input bytes, "text": the
//! formatted string}.

use hyperlane_core::{H160, H256, U256};
use serde_json::{json, Value};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

use crate::hex;

fn keys() -> Vec<(String, [u8; 32])> {
    let mut out = vec![
        ("zero".to_string(), [0u8; 32]),
        ("ff".to_string(), [0xffu8; 32]),
        ("seq1".to_string(), crate::seq32(1)),
        ("seq200".to_string(), crate::seq32(200)),
    ];
    // Leading zero bytes become leading '1's in base58.
    for zeros in [1usize, 2, 5, 31] {
        let mut k = [0x5au8; 32];
        k[..zeros].fill(0);
        out.push((format!("lead{zeros}"), k));
    }
    // A deterministic spread of bytes.
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    for i in 0..16 {
        let mut k = [0u8; 32];
        for b in k.iter_mut() {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            *b = x as u8;
        }
        out.push((format!("mix{i}"), k));
    }
    out
}

fn text(m: &mut serde_json::Map<String, Value>, name: String, input: &[u8], text: String) {
    m.insert(name, json!({"hex": hex(input), "text": text}));
}

pub fn extend(out: &mut Value) {
    let mut m = serde_json::Map::new();
    for (name, k) in keys() {
        let pk = Pubkey::new_from_array(k);
        let h = H256::from(k);
        let mut k20 = [0u8; 20];
        k20.copy_from_slice(&k[..20]);
        let a = H160::from(k20);
        text(&mut m, format!("pubkey_{name}"), &k, format!("{pk}"));
        text(&mut m, format!("pubkey_debug_{name}"), &k, format!("{pk:?}"));
        text(&mut m, format!("some_pubkey_{name}"), &k, format!("{:?}", Some(pk)));
        text(&mut m, format!("h256_{name}"), &k, format!("{h}"));
        text(&mut m, format!("h256_debug_{name}"), &k, format!("{h:?}"));
        text(&mut m, format!("some_h256_{name}"), &k, format!("{:?}", Some(h)));
        text(&mut m, format!("h160_{name}"), &k20, format!("{a}"));
        text(&mut m, format!("h160_debug_{name}"), &k20, format!("{a:?}"));
    }
    text(&mut m, "none_pubkey".into(), &[], format!("{:?}", None::<Pubkey>));
    for v in [0u64, 1, 9, 10, 1_000_000_007, u32::MAX as u64, u64::MAX] {
        text(&mut m, format!("u64_{v}"), &v.to_le_bytes(), format!("{v}"));
        text(&mut m, format!("some_u64_{v}"), &v.to_le_bytes(), format!("{:?}", Some(v)));
    }
    let u256s = [
        U256::zero(),
        U256::from(u64::MAX),
        U256::from(u64::MAX) + 1,
        U256::exp10(19),
        U256::exp10(19) - 1,
        U256::exp10(38) + 5,
        U256::exp10(57) * 7 + 3,
        U256::MAX,
    ];
    for (i, v) in u256s.iter().enumerate() {
        let mut b = Vec::new();
        for limb in v.0 {
            b.extend_from_slice(&limb.to_le_bytes());
        }
        text(&mut m, format!("u256_{i}"), &b, format!("{v}"));
    }
    for v in [0i64, -1, 1_700_000_000, i64::MIN, i64::MAX] {
        text(&mut m, format!("i64_{v}"), &v.to_le_bytes(), format!("{v}"));
    }
    for e in [
        ProgramError::Custom(0),
        ProgramError::Custom(1),
        ProgramError::Custom(0xdead_beef),
        ProgramError::InvalidArgument,
        ProgramError::InvalidInstructionData,
        ProgramError::InvalidAccountData,
        ProgramError::AccountDataTooSmall,
        ProgramError::InsufficientFunds,
        ProgramError::IncorrectProgramId,
        ProgramError::MissingRequiredSignature,
        ProgramError::AccountAlreadyInitialized,
        ProgramError::UninitializedAccount,
        ProgramError::NotEnoughAccountKeys,
        ProgramError::AccountBorrowFailed,
        ProgramError::MaxSeedLengthExceeded,
        ProgramError::InvalidSeeds,
        ProgramError::BorshIoError,
        ProgramError::AccountNotRentExempt,
        ProgramError::UnsupportedSysvar,
        ProgramError::IllegalOwner,
        ProgramError::MaxAccountsDataAllocationsExceeded,
        ProgramError::InvalidRealloc,
        ProgramError::MaxInstructionTraceLengthExceeded,
        ProgramError::BuiltinProgramsMustConsumeComputeUnits,
        ProgramError::InvalidAccountOwner,
        ProgramError::ArithmeticOverflow,
        ProgramError::Immutable,
        ProgramError::IncorrectAuthority,
    ] {
        let code = u64::from(e.clone());
        text(&mut m, format!("program_error_{code:x}"), &code.to_le_bytes(), format!("{e}"));
    }
    out.as_object_mut()
        .unwrap()
        .insert("log".into(), Value::Object(m));
}
