//! EXECUTE_CROSS_CHAIN (0x13) — dispatch commit + reveal Hyperlane messages to EVM ICA router.
//!
//! Mirrors the EVM Universal Router's EXECUTE_CROSS_CHAIN command (`callRemoteCommitReveal`).
//! Typically chained after BRIDGE_TOKEN to initiate a Solana→EVM destination swap.
//!
//! Dispatches two OutboxDispatch messages to the Hyperlane mailbox:
//!
//!   Commit body (129 bytes) — InterchainAccountMessage.encodeCommitment:
//!     [0]      0x01                = MessageType.COMMITMENT
//!     [1:33]   dispatch_auth_pda   = ICA owner (this program's Hyperlane sender)
//!     [33:65]  ism                 = zero bytes32 → default ISM
//!     [65:97]  user_salt           = user's Solana pubkey as bytes32
//!     [97:129] commitment          = keccak256 commitment hash
//!
//!   Reveal body (65 bytes) — InterchainAccountMessage.encodeReveal:
//!     [0]     0x02   = MessageType.REVEAL
//!     [1:33]  ism    = zero bytes32 → CCIP_READ_ISM default
//!     [33:65] commitment
//!
//! remaining_accounts (11):
//!   [0]  mailbox_program           — Hyperlane mailbox
//!   [1]  mailbox_outbox  writable
//!   [2]  dispatch_auth_pda         — this program's Hyperlane dispatch authority PDA
//!   [3]  system_program
//!   [4]  spl_noop
//!   [5]  unique_msg_commit  signer (readonly)
//!   [6]  dispatched_commit  writable
//!   [7]  gas_payment_commit writable
//!   [8]  unique_msg_reveal  signer (readonly)
//!   [9]  dispatched_reveal  writable
//!   [10] gas_payment_reveal writable

use hyperlane_core::H256;
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds,
};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
};
use solana_system_interface::instruction as system_instruction;

use crate::error::RouterError;

pub fn execute_cross_chain<'info>(
    destination_domain: u32,
    ica_router: [u8; 32],
    ism: [u8; 32],
    commitment: [u8; 32],
    commit_msg_fee: u64,
    reveal_msg_fee: u64,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
) -> ProgramResult {
    if accounts.len() < 11 {
        return Err(RouterError::InsufficientAccounts.into());
    }

    // dispatch_auth_pda is the Hyperlane message sender (= ICA owner on EVM)
    let dispatch_auth_pda_key: [u8; 32] = accounts[2].key.to_bytes();
    // user_salt = user's Solana pubkey as bytes32 → determines EVM ICA derivation
    let user_salt: [u8; 32] = authority.key.to_bytes();

    // Commit body: 0x01 || owner(32) || ism(32) || userSalt(32) || commitment(32) = 129 bytes
    let mut commit_body = Vec::with_capacity(129);
    commit_body.push(0x01u8);
    commit_body.extend_from_slice(&dispatch_auth_pda_key);
    commit_body.extend_from_slice(&ism);
    commit_body.extend_from_slice(&user_salt);
    commit_body.extend_from_slice(&commitment);

    // Reveal body: 0x02 || ism(32) || commitment(32) = 65 bytes
    let mut reveal_body = Vec::with_capacity(65);
    reveal_body.push(0x02u8);
    reveal_body.extend_from_slice(&ism);
    reveal_body.extend_from_slice(&commitment);

    // Derive dispatch authority bump for invoke_signed
    let (_, dispatch_auth_bump) = solana_program::pubkey::Pubkey::find_program_address(
        mailbox_message_dispatch_authority_pda_seeds!(),
        &crate::ID,
    );
    let signer_seeds: &[&[u8]] = mailbox_message_dispatch_authority_pda_seeds!(dispatch_auth_bump);

    dispatch_one(
        destination_domain,
        ica_router,
        &commit_body,
        commit_msg_fee,
        authority,
        signer_seeds,
        &accounts[0], // mailbox_program
        &accounts[1], // mailbox_outbox
        &accounts[2], // dispatch_auth_pda
        &accounts[3], // system_program
        &accounts[4], // spl_noop
        &accounts[5], // unique_msg_commit
        &accounts[6], // dispatched_commit
        &accounts[7], // gas_payment_commit
    )?;

    dispatch_one(
        destination_domain,
        ica_router,
        &reveal_body,
        reveal_msg_fee,
        authority,
        signer_seeds,
        &accounts[0],  // mailbox_program
        &accounts[1],  // mailbox_outbox
        &accounts[2],  // dispatch_auth_pda
        &accounts[3],  // system_program
        &accounts[4],  // spl_noop
        &accounts[8],  // unique_msg_reveal
        &accounts[9],  // dispatched_reveal
        &accounts[10], // gas_payment_reveal
    )?;

    Ok(())
}

/// CPI into the Hyperlane mailbox to dispatch a single message.
///
/// Account ordering (matches mailbox processor.rs OutboxDispatch):
///   [0] outbox (writable)
///   [1] dispatch_authority (readonly+signer — signs via invoke_signed PDA seeds)
///   [2] system_program
///   [3] spl_noop
///   [4] payer (writable+signer)
///   [5] unique_message (readonly+signer)
///   [6] dispatched_message (writable)
#[allow(clippy::too_many_arguments)]
fn dispatch_one<'info>(
    destination_domain: u32,
    recipient: [u8; 32],
    message_body: &[u8],
    msg_fee: u64,
    authority: &AccountInfo<'info>,
    signer_seeds: &[&[u8]],
    mailbox_program: &AccountInfo<'info>,
    mailbox_outbox: &AccountInfo<'info>,
    dispatch_auth_pda: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    spl_noop: &AccountInfo<'info>,
    unique_message: &AccountInfo<'info>,
    dispatched_message: &AccountInfo<'info>,
    gas_payment: &AccountInfo<'info>,
) -> ProgramResult {
    // Pre-fund gas payment PDA
    if msg_fee > 0 {
        invoke(
            &system_instruction::transfer(authority.key, gas_payment.key, msg_fee),
            &[authority.clone(), gas_payment.clone()],
        )?;
    }

    let ix_data = MailboxInstruction::OutboxDispatch(OutboxDispatch {
        sender: *dispatch_auth_pda.key,
        destination_domain,
        recipient: H256::from(recipient),
        message_body: message_body.to_vec(),
    })
    .into_instruction_data()?;

    let account_metas = vec![
        AccountMeta::new(*mailbox_outbox.key, false), // [0] outbox
        AccountMeta::new_readonly(*dispatch_auth_pda.key, true), // [1] dispatch_auth (readonly+signer)
        AccountMeta::new_readonly(*system_program.key, false),   // [2] system_program
        AccountMeta::new_readonly(*spl_noop.key, false),         // [3] spl_noop
        AccountMeta::new(*authority.key, true),                  // [4] payer
        AccountMeta::new_readonly(*unique_message.key, true),    // [5] unique_msg (readonly+signer)
        AccountMeta::new(*dispatched_message.key, false),        // [6] dispatched_msg
    ];

    let ix = Instruction {
        program_id: *mailbox_program.key,
        accounts: account_metas,
        data: ix_data,
    };

    let account_infos = [
        mailbox_outbox.clone(),
        dispatch_auth_pda.clone(),
        system_program.clone(),
        spl_noop.clone(),
        authority.clone(),
        unique_message.clone(),
        dispatched_message.clone(),
    ];

    // dispatch_auth_pda is a PDA of this program — sign on its behalf
    invoke_signed(&ix, &account_infos, &[signer_seeds])?;

    Ok(())
}
