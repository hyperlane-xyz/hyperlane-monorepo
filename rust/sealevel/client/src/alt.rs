//! Address Lookup Table (ALT) management for Hyperlane Sealevel.
//!
//! Creates ALTs containing common static accounts to reduce transaction size
//! for message processing.

use solana_address_lookup_table_program::instruction::{
    create_lookup_table, extend_lookup_table, freeze_lookup_table,
};
use solana_program::pubkey;
use solana_sdk::pubkey::Pubkey;

use hyperlane_sealevel_mailbox::mailbox_inbox_pda_seeds;

use crate::{AltCmd, AltSubCmd, Context};

// Well-known program/account addresses eligible for ALT compression.
// Programs called via CPI are in the accounts array, so they're eligible.
const SPL_NOOP: Pubkey = pubkey!("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub(crate) fn process_alt_cmd(ctx: Context, cmd: AltCmd) {
    match cmd.cmd {
        AltSubCmd::Create(create) => create_alt(&ctx, &create),
    }
}

fn create_alt(ctx: &Context, cmd: &crate::AltCreateCmd) {
    // 1. Derive inbox PDA from mailbox
    let (inbox_pda, _) = Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), &cmd.mailbox);

    // 2. Get recent slot for ALT derivation
    let recent_slot = ctx.client.get_slot().unwrap();

    // 3. Create ALT (authority = payer initially)
    let (create_ix, alt_address) =
        create_lookup_table(ctx.payer_pubkey, ctx.payer_pubkey, recent_slot);

    ctx.new_txn()
        .add_with_description(create_ix, "Create ALT")
        .send_with_payer();

    println!("Created ALT: {}", alt_address);

    // 4. Extend ALT with common addresses
    // Programs called via CPI are in accounts array, so they're eligible!
    let addresses = vec![
        solana_sdk::system_program::ID,
        inbox_pda,
        SPL_NOOP,
        TOKEN_PROGRAM,      // CPI'd by warp routes
        TOKEN_2022_PROGRAM, // CPI'd by synthetic warp routes
        ATA_PROGRAM,        // CPI'd by warp routes
    ];

    let extend_ix = extend_lookup_table(
        alt_address,
        ctx.payer_pubkey,
        Some(ctx.payer_pubkey),
        addresses.clone(),
    );

    ctx.new_txn()
        .add_with_description(extend_ix, "Extend ALT with addresses")
        .send_with_payer();

    println!("Extended ALT with {} addresses", addresses.len());

    // 5. Freeze ALT (make immutable)
    let freeze_ix = freeze_lookup_table(alt_address, ctx.payer_pubkey);

    ctx.new_txn()
        .add_with_description(freeze_ix, "Freeze ALT (make immutable)")
        .send_with_payer();

    println!("Froze ALT (now immutable)");
    println!("\n=== ALT CREATED ===");
    println!("Address: {}", alt_address);
    println!("Accounts ({}):", addresses.len());
    for (i, addr) in addresses.iter().enumerate() {
        println!("  [{}] {}", i, addr);
    }
}
