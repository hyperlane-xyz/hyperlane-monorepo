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
//!   [9]  unique_msg_commit  — UR-derived PDA (not external signer; signed via invoke_signed)
//!   [10] dispatched_commit  writable
//!   [11] gas_payment_commit writable
//!   Reveal-specific (3):
//!   [12] unique_msg_reveal  — UR-derived PDA (not external signer; signed via invoke_signed)
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
    program::{get_return_data, invoke_signed},
    pubkey::Pubkey,
};

use crate::{
    constants::{HYPERLANE_IGP_PROGRAM_ID, HYPERLANE_MAILBOX_PROGRAM_ID, UNIQUE_MSG_SEED},
    error::RouterError,
};

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

    // Validate accounts[0] is the known Hyperlane mailbox — prevents a caller
    // from passing a malicious program that would receive the user's authority
    // as a writable signer via invoke_signed.
    if *accounts[0].key != HYPERLANE_MAILBOX_PROGRAM_ID {
        return Err(RouterError::InvalidInputs.into());
    }

    // Validate accounts[5] is the known Hyperlane IGP program — prevents a caller
    // from substituting a malicious program that receives user authority as a writable
    // signer via invoke() during the PayForGas CPI (triggered when msg_fee > 0).
    if *accounts[5].key != HYPERLANE_IGP_PROGRAM_ID {
        return Err(RouterError::InvalidInputs.into());
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
    let (_, dispatch_auth_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), &crate::ID);
    let dispatch_auth_seeds: &[&[u8]] =
        mailbox_message_dispatch_authority_pda_seeds!(dispatch_auth_bump);

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
        &commitment,
        0, // dispatch_index: 0 = commit
        dispatch_auth_seeds,
        &accounts[0], // mailbox_program
        &accounts[1], // mailbox_outbox
        &accounts[2], // dispatch_auth_pda
        &accounts[3], // system_program
        &accounts[4], // spl_noop
        igp_program,
        igp_program_data,
        igp_account,
        overhead_igp,
        &accounts[9],  // unique_msg_commit (UR-derived PDA)
        &accounts[10], // dispatched_commit
        &accounts[11], // gas_payment_commit
    )?;

    dispatch_one(
        destination_domain,
        ica_router,
        &reveal_body,
        reveal_msg_fee,
        authority,
        &commitment,
        1, // dispatch_index: 1 = reveal
        dispatch_auth_seeds,
        &accounts[0], // mailbox_program
        &accounts[1], // mailbox_outbox
        &accounts[2], // dispatch_auth_pda
        &accounts[3], // system_program
        &accounts[4], // spl_noop
        igp_program,
        igp_program_data,
        igp_account,
        overhead_igp,
        &accounts[12], // unique_msg_reveal (UR-derived PDA)
        &accounts[13], // dispatched_reveal
        &accounts[14], // gas_payment_reveal
    )?;

    Ok(())
}

/// CPI into the Hyperlane mailbox to dispatch a single message, then pays the IGP.
///
/// The unique-message account is a UR-derived PDA (not an external ephemeral signer).
/// The UR signs for it via invoke_signed, saving one 64-byte signature per dispatch.
///
/// Steps:
///   1. Derive + verify unique_msg PDA from [UNIQUE_MSG_SEED, authority, commitment, dispatch_index]
///   2. invoke_signed → mailbox OutboxDispatch (creates dispatched_message PDA)
///   3. Read message ID from mailbox return data
///   4. invoke_signed → IGP PayForGas (creates gas_payment PDA the relayer can find)
#[allow(clippy::too_many_arguments)]
fn dispatch_one<'info>(
    destination_domain: u32,
    recipient: [u8; 32],
    message_body: &[u8],
    msg_fee: u64,
    authority: &AccountInfo<'info>,
    commitment: &[u8; 32],
    dispatch_index: u8,
    dispatch_auth_seeds: &[&[u8]],
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
    // ── Step 1: Derive + verify the unique-message PDA ─────────────────────
    let dispatch_index_byte = [dispatch_index];
    let (unique_msg_pda, unique_msg_bump) = Pubkey::find_program_address(
        &[
            UNIQUE_MSG_SEED,
            authority.key.as_ref(),
            commitment.as_ref(),
            &dispatch_index_byte,
        ],
        &crate::ID,
    );
    if *unique_message.key != unique_msg_pda {
        return Err(RouterError::InvalidInputs.into());
    }
    let unique_msg_bump_bytes = [unique_msg_bump];
    let unique_msg_seeds: &[&[u8]] = &[
        UNIQUE_MSG_SEED,
        authority.key.as_ref(),
        commitment.as_ref(),
        &dispatch_index_byte,
        &unique_msg_bump_bytes,
    ];

    // ── Step 2: Dispatch the Hyperlane message ──────────────────────────────
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
        AccountMeta::new_readonly(*unique_message.key, true), // [5] unique_msg (PDA signer via invoke_signed)
        AccountMeta::new(*dispatched_message.key, false),     // [6] dispatched_msg
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
        &[dispatch_auth_seeds, unique_msg_seeds],
    )?;

    // ── Step 3: Read message ID from mailbox return data ───────────────────
    if msg_fee > 0 {
        let (returning_program_id, returned_data) =
            get_return_data().ok_or(RouterError::InvalidInputs)?;
        if returning_program_id != *mailbox_program.key {
            return Err(RouterError::InvalidInputs.into());
        }
        let message_id = H256::from_slice(&returned_data);

        // ── Step 4: Pay the IGP ─────────────────────────────────────────────
        //
        // Account layout (matches hyperlane-sealevel-igp pay_for_gas_instruction):
        //   [0] system_program (readonly)
        //   [1] payer (writable signer)
        //   [2] igp_program_data (writable)
        //   [3] unique_gas_payment_account (readonly signer) — reuses unique_msg PDA
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
            AccountMeta::new_readonly(*unique_message.key, true), // [3] PDA signer via invoke_signed
            AccountMeta::new(*gas_payment.key, false),            // [4] writable
            AccountMeta::new(*igp_account.key, false),            // [5] writable
            AccountMeta::new_readonly(*overhead_igp.key, false),  // [6] readonly
        ];

        let igp_ix = Instruction {
            program_id: *igp_program.key,
            accounts: igp_account_metas,
            data: igp_ix_data,
        };

        invoke_signed(
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
            &[unique_msg_seeds],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        constants::{HYPERLANE_IGP_PROGRAM_ID, HYPERLANE_MAILBOX_PROGRAM_ID},
        error::RouterError,
    };
    use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

    fn make_account<'a>(
        key: &'a Pubkey,
        lamports: &'a mut u64,
        data: &'a mut Vec<u8>,
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(
            key,
            false,
            false,
            lamports,
            data.as_mut_slice(),
            owner,
            false,
        )
    }

    /// HIGH-3 regression: execute_cross_chain must reject unknown mailbox programs.
    /// BEFORE FIX: any program_id could be passed at accounts[0]; it would be used as
    ///   the CPI target, letting a malicious program receive user authority as signer.
    /// AFTER FIX: InvalidInputs if accounts[0].key != HYPERLANE_MAILBOX_PROGRAM_ID.
    #[test]
    fn test_execute_cross_chain_rejects_unknown_mailbox_program() {
        let wrong_mailbox = Pubkey::new_unique(); // NOT HYPERLANE_MAILBOX_PROGRAM_ID
        let k1 = Pubkey::new_unique();
        let k2 = Pubkey::new_unique();
        let k3 = Pubkey::new_unique();
        let k4 = Pubkey::new_unique();
        let k5 = Pubkey::new_unique();
        let k6 = Pubkey::new_unique();
        let k7 = Pubkey::new_unique();
        let k8 = Pubkey::new_unique();
        let k9 = Pubkey::new_unique();
        let k10 = Pubkey::new_unique();
        let k11 = Pubkey::new_unique();
        let k12 = Pubkey::new_unique();
        let k13 = Pubkey::new_unique();
        let k14 = Pubkey::new_unique();
        let authority_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut l7 = 0u64;
        let mut l8 = 0u64;
        let mut l9 = 0u64;
        let mut l10 = 0u64;
        let mut l11 = 0u64;
        let mut l12 = 0u64;
        let mut l13 = 0u64;
        let mut l14 = 0u64;
        let mut la = 0u64;
        let mut d0 = vec![];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = vec![];
        let mut d6 = vec![];
        let mut d7 = vec![];
        let mut d8 = vec![];
        let mut d9 = vec![];
        let mut d10 = vec![];
        let mut d11 = vec![];
        let mut d12 = vec![];
        let mut d13 = vec![];
        let mut d14 = vec![];
        let mut da = vec![];
        let accounts = vec![
            make_account(&wrong_mailbox, &mut l0, &mut d0, &owner),
            make_account(&k1, &mut l1, &mut d1, &owner),
            make_account(&k2, &mut l2, &mut d2, &owner),
            make_account(&k3, &mut l3, &mut d3, &owner),
            make_account(&k4, &mut l4, &mut d4, &owner),
            make_account(&k5, &mut l5, &mut d5, &owner),
            make_account(&k6, &mut l6, &mut d6, &owner),
            make_account(&k7, &mut l7, &mut d7, &owner),
            make_account(&k8, &mut l8, &mut d8, &owner),
            make_account(&k9, &mut l9, &mut d9, &owner),
            make_account(&k10, &mut l10, &mut d10, &owner),
            make_account(&k11, &mut l11, &mut d11, &owner),
            make_account(&k12, &mut l12, &mut d12, &owner),
            make_account(&k13, &mut l13, &mut d13, &owner),
            make_account(&k14, &mut l14, &mut d14, &owner),
        ];
        let authority = make_account(&authority_key, &mut la, &mut da, &owner);
        let result = execute_cross_chain(
            1, [0u8; 32], [0u8; 32], [0u8; 32], 0, 0, &authority, &accounts,
        );
        // AFTER FIX: InvalidInputs — wrong mailbox rejected before any CPI
        // BEFORE FIX: would proceed to invoke_signed and use wrong_mailbox as CPI target
        assert_eq!(result, Err(RouterError::InvalidInputs.into()));
    }

    /// MEDIUM regression: unknown IGP at accounts[5] must be rejected.
    /// BEFORE FIX: any program could be passed; on msg_fee > 0 it receives user authority
    ///   as a writable signer via invoke(), enabling fund theft.
    /// AFTER FIX: InvalidInputs if accounts[5].key != HYPERLANE_IGP_PROGRAM_ID.
    #[test]
    fn test_execute_cross_chain_rejects_unknown_igp_program() {
        let wrong_igp = Pubkey::new_unique(); // NOT HYPERLANE_IGP_PROGRAM_ID
        let k1 = Pubkey::new_unique();
        let k2 = Pubkey::new_unique();
        let k3 = Pubkey::new_unique();
        let k4 = Pubkey::new_unique();
        let k6 = Pubkey::new_unique();
        let k7 = Pubkey::new_unique();
        let k8 = Pubkey::new_unique();
        let k9 = Pubkey::new_unique();
        let k10 = Pubkey::new_unique();
        let k11 = Pubkey::new_unique();
        let k12 = Pubkey::new_unique();
        let k13 = Pubkey::new_unique();
        let k14 = Pubkey::new_unique();
        let authority_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut l7 = 0u64;
        let mut l8 = 0u64;
        let mut l9 = 0u64;
        let mut l10 = 0u64;
        let mut l11 = 0u64;
        let mut l12 = 0u64;
        let mut l13 = 0u64;
        let mut l14 = 0u64;
        let mut la = 0u64;
        let mut d0 = vec![];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = vec![];
        let mut d6 = vec![];
        let mut d7 = vec![];
        let mut d8 = vec![];
        let mut d9 = vec![];
        let mut d10 = vec![];
        let mut d11 = vec![];
        let mut d12 = vec![];
        let mut d13 = vec![];
        let mut d14 = vec![];
        let mut da = vec![];
        let accounts = vec![
            make_account(&HYPERLANE_MAILBOX_PROGRAM_ID, &mut l0, &mut d0, &owner),
            make_account(&k1, &mut l1, &mut d1, &owner),
            make_account(&k2, &mut l2, &mut d2, &owner),
            make_account(&k3, &mut l3, &mut d3, &owner),
            make_account(&k4, &mut l4, &mut d4, &owner),
            make_account(&wrong_igp, &mut l5, &mut d5, &owner), // [5] wrong IGP program
            make_account(&k6, &mut l6, &mut d6, &owner),
            make_account(&k7, &mut l7, &mut d7, &owner),
            make_account(&k8, &mut l8, &mut d8, &owner),
            make_account(&k9, &mut l9, &mut d9, &owner),
            make_account(&k10, &mut l10, &mut d10, &owner),
            make_account(&k11, &mut l11, &mut d11, &owner),
            make_account(&k12, &mut l12, &mut d12, &owner),
            make_account(&k13, &mut l13, &mut d13, &owner),
            make_account(&k14, &mut l14, &mut d14, &owner),
        ];
        let authority = make_account(&authority_key, &mut la, &mut da, &owner);
        let result = execute_cross_chain(
            1, [0u8; 32], [0u8; 32], [0u8; 32], 0, 0, &authority, &accounts,
        );
        assert_eq!(result, Err(RouterError::InvalidInputs.into()));
    }

    /// Correct mailbox at [0] and correct IGP at [5] — both validations pass.
    /// Now also requires correct unique_msg PDAs at [9] and [12]; fails at CPI (not at our checks).
    #[test]
    fn test_execute_cross_chain_accepts_correct_mailbox_and_igp() {
        let k1 = Pubkey::new_unique();
        let k2 = Pubkey::new_unique();
        let k3 = Pubkey::new_unique();
        let k4 = Pubkey::new_unique();
        let k6 = Pubkey::new_unique();
        let k7 = Pubkey::new_unique();
        let k8 = Pubkey::new_unique();
        let k10 = Pubkey::new_unique();
        let k11 = Pubkey::new_unique();
        let k13 = Pubkey::new_unique();
        let k14 = Pubkey::new_unique();
        let authority_key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let commitment = [0u8; 32];
        // Derive the correct unique_msg PDAs that dispatch_one now verifies
        let (commit_pda, _) = Pubkey::find_program_address(
            &[
                crate::constants::UNIQUE_MSG_SEED,
                authority_key.as_ref(),
                commitment.as_ref(),
                &[0u8],
            ],
            &crate::ID,
        );
        let (reveal_pda, _) = Pubkey::find_program_address(
            &[
                crate::constants::UNIQUE_MSG_SEED,
                authority_key.as_ref(),
                commitment.as_ref(),
                &[1u8],
            ],
            &crate::ID,
        );
        let mut l0 = 0u64;
        let mut l1 = 0u64;
        let mut l2 = 0u64;
        let mut l3 = 0u64;
        let mut l4 = 0u64;
        let mut l5 = 0u64;
        let mut l6 = 0u64;
        let mut l7 = 0u64;
        let mut l8 = 0u64;
        let mut l9 = 0u64;
        let mut l10 = 0u64;
        let mut l11 = 0u64;
        let mut l12 = 0u64;
        let mut l13 = 0u64;
        let mut l14 = 0u64;
        let mut la = 0u64;
        let mut d0 = vec![];
        let mut d1 = vec![];
        let mut d2 = vec![];
        let mut d3 = vec![];
        let mut d4 = vec![];
        let mut d5 = vec![];
        let mut d6 = vec![];
        let mut d7 = vec![];
        let mut d8 = vec![];
        let mut d9 = vec![];
        let mut d10 = vec![];
        let mut d11 = vec![];
        let mut d12 = vec![];
        let mut d13 = vec![];
        let mut d14 = vec![];
        let mut da = vec![];
        let accounts = vec![
            make_account(&HYPERLANE_MAILBOX_PROGRAM_ID, &mut l0, &mut d0, &owner), // [0] correct mailbox
            make_account(&k1, &mut l1, &mut d1, &owner),
            make_account(&k2, &mut l2, &mut d2, &owner),
            make_account(&k3, &mut l3, &mut d3, &owner),
            make_account(&k4, &mut l4, &mut d4, &owner),
            make_account(&HYPERLANE_IGP_PROGRAM_ID, &mut l5, &mut d5, &owner), // [5] correct IGP
            make_account(&k6, &mut l6, &mut d6, &owner),
            make_account(&k7, &mut l7, &mut d7, &owner),
            make_account(&k8, &mut l8, &mut d8, &owner),
            make_account(&commit_pda, &mut l9, &mut d9, &owner), // [9]  commit unique_msg PDA
            make_account(&k10, &mut l10, &mut d10, &owner),
            make_account(&k11, &mut l11, &mut d11, &owner),
            make_account(&reveal_pda, &mut l12, &mut d12, &owner), // [12] reveal unique_msg PDA
            make_account(&k13, &mut l13, &mut d13, &owner),
            make_account(&k14, &mut l14, &mut d14, &owner),
        ];
        let authority = make_account(&authority_key, &mut la, &mut da, &owner);
        let result = execute_cross_chain(
            1, [0u8; 32], [0u8; 32], commitment, 0, 0, &authority, &accounts,
        );
        // All three checks (mailbox, IGP, PDA) pass; fails later at invoke_signed — NOT InvalidInputs
        assert_ne!(
            result,
            Err(RouterError::InvalidInputs.into()),
            "correct mailbox, IGP, and unique_msg PDAs must pass all validations"
        );
    }
}
