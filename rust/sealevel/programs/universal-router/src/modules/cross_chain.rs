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
//! remaining_accounts (15):
//!   Shared (9):
//!   [0]  mailbox_program           — Hyperlane mailbox
//!   [1]  mailbox_outbox  writable
//!   [2]  dispatch_auth_pda         — this program's Hyperlane dispatch authority PDA
//!   [3]  system_program
//!   [4]  spl_noop
//!   [5]  igp_program               — Hyperlane IGP executable (for payForGas CPI)
//!   [6]  igp_program_data writable — IGP program data PDA
//!   [7]  igp_account      writable — plain IGP account
//!   [8]  overhead_igp              — overhead IGP account (readonly)
//!   Commit-specific (3):
//!   [9]  unique_msg_commit  signer
//!   [10] dispatched_commit  writable
//!   [11] gas_payment_commit writable
//!   Reveal-specific (3):
//!   [12] unique_msg_reveal  signer
//!   [13] dispatched_reveal  writable
//!   [14] gas_payment_reveal writable

use hyperlane_core::H256;
use hyperlane_sealevel_igp::instruction::{
    Instruction as IgpInstruction, PayForGas as IgpPayForGas,
};
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds,
};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
};

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
    if accounts.len() < 15 {
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

    // Shared IGP accounts
    let igp_program = &accounts[5];
    let igp_program_data = &accounts[6];
    let igp_account = &accounts[7];
    let overhead_igp = &accounts[8];

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
        igp_program,
        igp_program_data,
        igp_account,
        overhead_igp,
        &accounts[9],  // unique_msg_commit
        &accounts[10], // dispatched_commit
        &accounts[11], // gas_payment_commit
    )?;

    dispatch_one(
        destination_domain,
        ica_router,
        &reveal_body,
        reveal_msg_fee,
        authority,
        signer_seeds,
        &accounts[0], // mailbox_program
        &accounts[1], // mailbox_outbox
        &accounts[2], // dispatch_auth_pda
        &accounts[3], // system_program
        &accounts[4], // spl_noop
        igp_program,
        igp_program_data,
        igp_account,
        overhead_igp,
        &accounts[12], // unique_msg_reveal
        &accounts[13], // dispatched_reveal
        &accounts[14], // gas_payment_reveal
    )?;

    Ok(())
}

/// CPI into the Hyperlane mailbox to dispatch a single message, then pays the IGP.
///
/// Steps:
///   1. invoke_signed → mailbox OutboxDispatch (creates dispatched_message PDA)
///   2. Read message ID from mailbox return data
///   3. invoke → IGP PayForGas (creates gas_payment PDA the relayer can find)
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
    igp_program: &AccountInfo<'info>,
    igp_program_data: &AccountInfo<'info>,
    igp_account: &AccountInfo<'info>,
    overhead_igp: &AccountInfo<'info>,
    unique_message: &AccountInfo<'info>,
    dispatched_message: &AccountInfo<'info>,
    gas_payment: &AccountInfo<'info>,
) -> ProgramResult {
    // ── Step 1: Dispatch the Hyperlane message ──────────────────────────────
    let ix_data = MailboxInstruction::OutboxDispatch(OutboxDispatch {
        sender: *dispatch_auth_pda.key,
        destination_domain,
        recipient: H256::from(recipient),
        message_body: message_body.to_vec(),
    })
    .into_instruction_data()?;

    let account_metas = vec![
        AccountMeta::new(*mailbox_outbox.key, false), // [0] outbox (writable)
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

    invoke_signed(
        &ix,
        &[
            mailbox_outbox.clone(),
            dispatch_auth_pda.clone(),
            system_program.clone(),
            spl_noop.clone(),
            authority.clone(),
            unique_message.clone(),
            dispatched_message.clone(),
        ],
        &[signer_seeds],
    )?;

    // ── Step 2: Read message ID from mailbox return data ───────────────────
    if msg_fee > 0 {
        let (returning_program_id, returned_data) =
            get_return_data().ok_or(RouterError::InvalidInputs)?;
        if returning_program_id != *mailbox_program.key {
            return Err(RouterError::InvalidInputs.into());
        }
        let message_id = H256::from_slice(&returned_data);

        // ── Step 3: Pay the IGP ─────────────────────────────────────────────
        //
        // Account layout (matches hyperlane-sealevel-igp pay_for_gas_instruction):
        //   [0] system_program (readonly)
        //   [1] payer (writable signer)
        //   [2] igp_program_data (writable)
        //   [3] unique_gas_payment_account (readonly signer) — reuses unique_message keypair
        //   [4] gas_payment_pda (writable)
        //   [5] igp_account (writable)
        //   [6] overhead_igp (readonly, optional — always included)
        let igp_ix_data = IgpInstruction::PayForGas(IgpPayForGas {
            message_id,
            destination_domain,
            gas_amount: msg_fee,
        })
        .into_instruction_data()?;

        let igp_account_metas = vec![
            AccountMeta::new_readonly(*system_program.key, false), // [0]
            AccountMeta::new(*authority.key, true),                // [1] payer (writable signer)
            AccountMeta::new(*igp_program_data.key, false),        // [2] writable
            AccountMeta::new_readonly(*unique_message.key, true),  // [3] readonly signer
            AccountMeta::new(*gas_payment.key, false),             // [4] writable
            AccountMeta::new(*igp_account.key, false),             // [5] writable
            AccountMeta::new_readonly(*overhead_igp.key, false),   // [6] readonly
        ];

        let igp_ix = Instruction {
            program_id: *igp_program.key,
            accounts: igp_account_metas,
            data: igp_ix_data,
        };

        invoke(
            &igp_ix,
            &[
                system_program.clone(),
                authority.clone(),
                igp_program_data.clone(),
                unique_message.clone(),
                gas_payment.clone(),
                igp_account.clone(),
                overhead_igp.clone(),
            ],
        )?;
    }

    Ok(())
}
