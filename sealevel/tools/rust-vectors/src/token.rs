//! SPL Token-2022 / ATA instruction encodings and IDs the Go token plugins
//! CPI with (the shared goldens cover the Hyperlane types).

use serde_json::{json, Map, Value};
use spl_associated_token_account_interface::{
    address::get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022_interface::instruction as t22;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn key(b: u8) -> solana_program::pubkey::Pubkey {
    solana_program::pubkey::Pubkey::new_from_array([b; 32])
}

/// `name -> {"hex": instruction data, "ok": true}`, plus `<name>_metas` as
/// `[pubkey(32) is_signer is_writable]*` and `<name>_program`.
pub fn token_group() -> Map<String, Value> {
    let mut g = Map::new();
    let mut put = |name: &str, ix: solana_program::instruction::Instruction| {
        g.insert(name.into(), json!({"hex": hex(&ix.data), "ok": true}));
        let mut metas = Vec::new();
        for m in &ix.accounts {
            metas.extend_from_slice(m.pubkey.as_ref());
            metas.push(m.is_signer as u8);
            metas.push(m.is_writable as u8);
        }
        g.insert(
            format!("{name}_metas"),
            json!({"hex": hex(&metas), "ok": true}),
        );
        g.insert(
            format!("{name}_program"),
            json!({"hex": hex(ix.program_id.as_ref()), "ok": true}),
        );
    };
    let t22_id = spl_token_2022_interface::id();
    let token_id = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    let (src, mint, dst, auth) = (key(1), key(2), key(3), key(4));
    put(
        "burn_checked_self_signer",
        t22::burn_checked(&t22_id, &src, &mint, &auth, &[&auth], 1_234_567_890, 9).unwrap(),
    );
    put(
        "transfer_checked",
        t22::transfer_checked(&t22_id, &src, &mint, &dst, &auth, &[], u64::MAX, 6).unwrap(),
    );
    put(
        "transfer_checked_classic",
        t22::transfer_checked(&token_id, &src, &mint, &dst, &auth, &[], 7, 0).unwrap(),
    );
    put(
        "mint_to_checked",
        t22::mint_to_checked(&t22_id, &mint, &dst, &mint, &[], 42, 18).unwrap(),
    );
    put(
        "get_account_data_size",
        t22::get_account_data_size(&t22_id, &mint, &[]).unwrap(),
    );
    put(
        "initialize_account",
        t22::initialize_account(&t22_id, &src, &mint, &src).unwrap(),
    );
    put(
        "create_idempotent",
        create_associated_token_account_idempotent(&key(5), &key(6), &mint, &t22_id),
    );
    let ata = get_associated_token_address_with_program_id(&key(6), &mint, &t22_id);
    g.insert(
        "ata_6_2_t22".into(),
        json!({"hex": hex(ata.as_ref()), "ok": true}),
    );
    let ata = get_associated_token_address_with_program_id(&key(6), &mint, &token_id);
    g.insert(
        "ata_6_2_token".into(),
        json!({"hex": hex(ata.as_ref()), "ok": true}),
    );
    for (name, id) in [
        ("id_token_2022", t22_id),
        ("id_token", token_id),
        (
            "id_ata",
            spl_associated_token_account_interface::program::id(),
        ),
        ("id_rent", solana_program::sysvar::rent::id()),
    ] {
        g.insert(name.into(), json!({"hex": hex(id.as_ref()), "ok": true}));
    }
    g
}
