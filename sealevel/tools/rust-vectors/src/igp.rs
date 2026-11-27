//! IGP vectors: compute_gas_fee over the overflow boundaries, and Igp
//! decoding of stale gas_oracles tails.

use std::collections::HashMap;

use borsh::BorshDeserialize;
use hyperlane_core::H256;
use hyperlane_sealevel_igp::accounts::{
    compute_gas_fee, GasOracle, Igp, IgpFeeConfig, RemoteGasData, TOKEN_EXCHANGE_RATE_SCALE,
};
use serde_json::Value;
use solana_program::pubkey::Pubkey;

use crate::Group;

/// One compute_gas_fee case: hex = rate u128 LE | gas_price u128 LE |
/// gas_amount u64 LE | decimals u8 | result u64 LE, where the result is the
/// fee (ok) or the ProgramError code (not ok).
fn fee_case(g: &mut Group, name: &str, rate: u128, price: u128, amount: u64, decimals: u8) {
    let mut b = Vec::new();
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&price.to_le_bytes());
    b.extend_from_slice(&amount.to_le_bytes());
    b.push(decimals);
    let (ok, out) = match compute_gas_fee(rate, price, amount, decimals) {
        Ok(fee) => (true, fee),
        Err(e) => (false, u64::from(e)),
    };
    b.extend_from_slice(&out.to_le_bytes());
    g.0.insert(
        format!("gas_fee_{name}"),
        serde_json::json!({"hex": crate::hex(&b), "ok": ok}),
    );
}

fn igp_with(domains: &[u32], fee_config: Option<IgpFeeConfig>) -> Igp {
    let mut gas_oracles = HashMap::new();
    for &domain in domains {
        gas_oracles.insert(
            domain,
            GasOracle::RemoteGasData(RemoteGasData {
                token_exchange_rate: 1_000_000_000,
                gas_price: 50_000_000_000,
                token_decimals: 18,
            }),
        );
    }
    Igp {
        bump_seed: 1,
        salt: H256::zero(),
        owner: Some(Pubkey::new_from_array([7u8; 32])),
        beneficiary: Pubkey::new_from_array([9u8; 32]),
        gas_oracles,
        fee_config: fee_config.into(),
    }
}

/// A pre-#8698 shrink: `keep`'s bytes over `before`'s, leaving a stale tail.
/// Records the bytes and borsh(Igp::deserialize_reader(bytes)).
fn stale_case(g: &mut Group, name: &str, before: &Igp, keep: &Igp) {
    let mut buf = borsh::to_vec(before).unwrap();
    let k = borsh::to_vec(keep).unwrap();
    buf[..k.len()].copy_from_slice(&k);
    let decoded = Igp::deserialize_reader(&mut &buf[..]).unwrap();
    g.ok(&format!("igp_{name}"), buf);
    g.ok(
        &format!("igp_{name}_decoded"),
        borsh::to_vec(&decoded).unwrap(),
    );
}

pub fn extend(out: &mut Value) {
    let mut g = Group::new();
    let scale = TOKEN_EXCHANGE_RATE_SCALE;
    // accounts.rs unit-test cases.
    fee_case(
        &mut g,
        "solaxy",
        27_849_410_632_667_789_280_000,
        6,
        900_000,
        9,
    );
    fee_case(&mut g, "one_to_one", scale, 1_000_000_000, 100_000, 9);
    fee_case(
        &mut g,
        "eighteen_decimals",
        scale,
        1_000_000_000,
        100_000,
        18,
    );
    fee_case(&mut g, "u64_overflow", scale, 10u128.pow(18), u64::MAX, 0);
    // U256 multiplication overflow, first and second product.
    fee_case(&mut g, "mul_overflow", u128::MAX, u128::MAX, u64::MAX, 9);
    fee_case(&mut g, "mul_max_fits", 1, u128::MAX, u64::MAX, 9);
    fee_case(&mut g, "zero", 0, 0, 0, 255);
    // Every decimals value: checked_pow overflows above 9 + 77.
    for d in 0..=255u8 {
        fee_case(
            &mut g,
            &format!("decimals_{d}"),
            u128::MAX / 3,
            123_456_789_012_345,
            987_654_321,
            d,
        );
        fee_case(&mut g, &format!("small_decimals_{d}"), scale, 3, 7, d);
    }
    // Deterministic pseudo-random inputs (xorshift).
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for i in 0..200 {
        let rate = (u128::from(next()) << 64 | u128::from(next())) >> (next() % 128);
        let price = (u128::from(next()) << 64 | u128::from(next())) >> (next() % 128);
        let amount = next() >> (next() % 64);
        let decimals = (next() % 40) as u8;
        fee_case(
            &mut g,
            &format!("random_{i}"),
            rate,
            price,
            amount,
            decimals,
        );
    }

    let fee_config = IgpFeeConfig {
        signers: [hyperlane_core::H160::repeat_byte(0x11)].into(),
        domain_id: 42,
        min_issued_at: 1000,
    };
    stale_case(
        &mut g,
        "stale_tail_02",
        &igp_with(&[0, 0xFF02], None),
        &igp_with(&[0], None),
    );
    stale_case(
        &mut g,
        "stale_tail_01",
        &igp_with(&[0, 1], None),
        &igp_with(&[0], None),
    );
    stale_case(
        &mut g,
        "fee_config_stale_tail",
        &igp_with(&[0, 0xFF02], Some(fee_config.clone())),
        &igp_with(&[0], Some(fee_config)),
    );
    out["igp"] = Value::Object(g.0);
}
