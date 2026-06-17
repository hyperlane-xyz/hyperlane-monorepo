//! BRIDGE_TOKEN (0x12) — Hyperlane warp route transfer_remote CPI
//!
//! CPIs into a Hyperlane native-Rust collateral token router program
//! to initiate a cross-chain token transfer.
//!
//! Instruction encoding uses `hyperlane-sealevel-token-lib` types:
//!   `Instruction::TransferRemote(TransferRemote { ... }).encode()`
//!
//! Account layout consumed from remaining_accounts:
//!
//!   [0]  token_router_program         — program_id for the CPI
//!
//! CPI accounts passed to the token router (positions match
//! `HyperlaneSealevelToken::transfer_remote` in the lib):
//!
//!   [1]  system_program               [executable]
//!   [2]  spl_noop                     [executable]
//!   [3]  token_pda                    []            (NOT writable)
//!   [4]  mailbox                      [executable]
//!   [5]  mailbox_outbox               [writable]
//!   [6]  dispatch_authority_pda       []
//!   ----  authority is injected here as sender_wallet (signer) ----
//!   [7]  unique_message_account       [signer] (NOT writable)
//!   [8]  dispatched_message_pda       [writable]
//!
//!   ---- IGP accounts (if present) ----
//!   [9]  igp_program                  [executable]
//!   [10] igp_program_data             [writable]
//!   [11] gas_payment_pda              [writable]
//!
//!   Regular IGP case (17 remaining accounts total):
//!   [12] configured_igp               [writable]
//!   [13] spl_token_program            [executable]   ← plugin[0]
//!   [14] token_mint                   [writable]     ← plugin[1]
//!   [15] token_sender_ata             [writable]     ← plugin[2]
//!   [16] escrow_pda                   [writable]     ← plugin[3]
//!
//!   Overhead IGP case (18 remaining accounts total):
//!   [12] configured_overhead_igp      []             (readonly — overhead IGP)
//!   [13] inner_igp                    [writable]
//!   [14] spl_token_program            [executable]   ← plugin[0]
//!   [15] token_mint                   [writable]     ← plugin[1]
//!   [16] token_sender_ata             [writable]     ← plugin[2]
//!   [17] escrow_pda                   [writable]     ← plugin[3]

use account_utils::DiscriminatorEncode;
use hyperlane_core::{H256, U256};
use hyperlane_sealevel_token_lib::instruction::{
    Instruction as HypTokenInstruction, TransferRemote,
};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
    program_pack::Pack,
};

use crate::{
    constants::{HYPERLANE_USDC_TOKEN_ROUTER, HYPERLANE_USDT_TOKEN_ROUTER, USDC_MINT, USDT_MINT},
    error::RouterError,
    types::{amount_sentinels::CONTRACT_BALANCE, BridgeType},
};

/// Minimum account count (regular IGP, no overhead).
const ACCOUNTS_REGULAR_IGP: usize = 17;
/// Account count for overhead IGP variant.
const ACCOUNTS_OVERHEAD_IGP: usize = 18;

pub fn execute_bridge_token<'info>(
    bridge_type: u8,
    destination_domain: u32,
    recipient: [u8; 32],
    amount: u64,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
) -> ProgramResult {
    if accounts.len() != ACCOUNTS_REGULAR_IGP && accounts.len() != ACCOUNTS_OVERHEAD_IGP {
        return Err(RouterError::InsufficientAccounts.into());
    }

    // Validate bridge type
    BridgeType::from_u8(bridge_type).ok_or(RouterError::UnsupportedBridgeType)?;

    let use_overhead_igp = accounts.len() == ACCOUNTS_OVERHEAD_IGP;

    let token_router_program = &accounts[0];
    // plugin accounts depend on IGP type
    let mint_idx = if use_overhead_igp { 15 } else { 14 };
    let sender_ata_idx = mint_idx + 1;

    // Only USDC or USDT supported
    if *accounts[mint_idx].key != USDC_MINT && *accounts[mint_idx].key != USDT_MINT {
        return Err(RouterError::UnsupportedBridgeType.into());
    }
    let expected_router = if *accounts[mint_idx].key == USDC_MINT {
        HYPERLANE_USDC_TOKEN_ROUTER
    } else {
        HYPERLANE_USDT_TOKEN_ROUTER
    };
    if *token_router_program.key != expected_router {
        return Err(RouterError::UnsupportedBridgeType.into());
    }

    // Resolve CONTRACT_BALANCE sentinel — read the sender's ATA balance
    let resolved_amount = if amount == CONTRACT_BALANCE {
        let data = accounts[sender_ata_idx].data.borrow();
        spl_token::state::Account::unpack(&data)
            .map_err(|_| RouterError::InvalidInputs)?
            .amount
    } else {
        amount
    };
    if resolved_amount == 0 {
        return Err(RouterError::InsufficientOutput.into());
    }

    // Build transfer_remote instruction data via official lib types
    let ix_data = HypTokenInstruction::TransferRemote(TransferRemote {
        destination_domain,
        recipient: H256::from(recipient),
        amount_or_id: U256::from(resolved_amount),
    })
    .encode()
    .map_err(|_| RouterError::InvalidInputs)?;

    // Build CPI account metas matching `HyperlaneSealevelToken::transfer_remote`:
    //
    //   0  system_program       (accounts[1])
    //   1  spl_noop             (accounts[2])
    //   2  token_pda            (accounts[3])  readonly — lib says `[]`
    //   3  mailbox              (accounts[4])
    //   4  mailbox_outbox       (accounts[5])  writable
    //   5  dispatch_authority   (accounts[6])  readonly
    //   6  sender_wallet        (authority)    writable + signer
    //   7  unique_message       (accounts[7])  readonly + signer
    //   8  dispatched_message   (accounts[8])  writable
    //   9  igp_program          (accounts[9])
    //   10 igp_data             (accounts[10]) writable
    //   11 gas_payment_pda      (accounts[11]) writable
    //   12 configured_igp       (accounts[12]) writable (Igp) / readonly (OverheadIgp)
    //   [13 inner_igp           (accounts[13]) writable  — only OverheadIgp]
    //   N  spl_token_program    writable=false
    //   N+1 mint                writable
    //   N+2 sender_ata          writable
    //   N+3 escrow              writable
    let mut account_metas = vec![
        AccountMeta::new_readonly(*accounts[1].key, false), // system_program
        AccountMeta::new_readonly(*accounts[2].key, false), // spl_noop
        AccountMeta::new_readonly(*accounts[3].key, false), // token_pda  (readonly)
        AccountMeta::new_readonly(*accounts[4].key, false), // mailbox
        AccountMeta::new(*accounts[5].key, false),          // mailbox_outbox  writable
        AccountMeta::new_readonly(*accounts[6].key, false), // dispatch_authority
        AccountMeta::new(*authority.key, true),             // sender_wallet  writable+signer
        AccountMeta::new_readonly(*accounts[7].key, true),  // unique_message  readonly+signer
        AccountMeta::new(*accounts[8].key, false),          // dispatched_message  writable
        AccountMeta::new_readonly(*accounts[9].key, false), // igp_program
        AccountMeta::new(*accounts[10].key, false),         // igp_program_data  writable
        AccountMeta::new(*accounts[11].key, false),         // gas_payment_pda  writable
    ];

    if use_overhead_igp {
        // configured_igp is the overhead IGP (readonly in downstream payment CPI)
        account_metas.push(AccountMeta::new_readonly(*accounts[12].key, false));
        // inner_igp is the actual IGP (writable)
        account_metas.push(AccountMeta::new(*accounts[13].key, false));
        // plugin accounts
        account_metas.push(AccountMeta::new_readonly(*accounts[14].key, false)); // spl_token_program
        account_metas.push(AccountMeta::new(*accounts[15].key, false)); // mint  writable
        account_metas.push(AccountMeta::new(*accounts[16].key, false)); // sender_ata  writable
        account_metas.push(AccountMeta::new(*accounts[17].key, false)); // escrow  writable
    } else {
        // configured_igp is the regular IGP (writable)
        account_metas.push(AccountMeta::new(*accounts[12].key, false));
        // plugin accounts
        account_metas.push(AccountMeta::new_readonly(*accounts[13].key, false)); // spl_token_program
        account_metas.push(AccountMeta::new(*accounts[14].key, false)); // mint  writable
        account_metas.push(AccountMeta::new(*accounts[15].key, false)); // sender_ata  writable
        account_metas.push(AccountMeta::new(*accounts[16].key, false)); // escrow  writable
    }

    let ix = Instruction {
        program_id: *token_router_program.key,
        accounts: account_metas,
        data: ix_data,
    };

    // Build account_infos — authority goes at position 6 (sender_wallet)
    let mut account_infos: Vec<AccountInfo> = vec![
        accounts[1].clone(),  // system_program
        accounts[2].clone(),  // spl_noop
        accounts[3].clone(),  // token_pda
        accounts[4].clone(),  // mailbox
        accounts[5].clone(),  // mailbox_outbox
        accounts[6].clone(),  // dispatch_authority
        authority.clone(),    // sender_wallet
        accounts[7].clone(),  // unique_message
        accounts[8].clone(),  // dispatched_message
        accounts[9].clone(),  // igp_program
        accounts[10].clone(), // igp_program_data
        accounts[11].clone(), // gas_payment_pda
        accounts[12].clone(), // configured_igp
    ];
    if use_overhead_igp {
        account_infos.push(accounts[13].clone()); // inner_igp
        account_infos.push(accounts[14].clone()); // spl_token_program
        account_infos.push(accounts[15].clone()); // mint
        account_infos.push(accounts[16].clone()); // sender_ata
        account_infos.push(accounts[17].clone()); // escrow
    } else {
        account_infos.push(accounts[13].clone()); // spl_token_program
        account_infos.push(accounts[14].clone()); // mint
        account_infos.push(accounts[15].clone()); // sender_ata
        account_infos.push(accounts[16].clone()); // escrow
    }

    invoke(&ix, &account_infos)
}
