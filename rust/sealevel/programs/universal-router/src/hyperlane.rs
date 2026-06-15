//! Hyperlane mailbox message-recipient interface.
//!
//! The mailbox calls four discriminated instructions on recipient programs.
//! Both commit and reveal messages arrive via the single `Handle` discriminator —
//! we disambiguate by message body length (commit = exactly 96 bytes).
//!
//! Uses `MessageRecipientInstruction` from `hyperlane-sealevel-message-recipient-interface`
//! for decoding and uses `SimulationReturnData<Vec<SerializableAccountMeta>>` from
//! `serializable-account-meta` for the HandleAccountMetas return value.
//!
//! Mailbox CPI account layouts:
//!
//!   Commit  [0] process_authority  signer
//!           [1] fee_payer_pda      writable
//!           [2] pending_swap       writable  (created here if absent)
//!           [3] system_program
//!
//!   Reveal  [0] process_authority  signer
//!           [1] fee_payer_pda      writable  (receives rent when PDA is closed)
//!           [2] pending_swap       writable  (closed on success)
//!           [3] pda_token_ata      writable
//!           [4] system_program
//!           [5..] swap command accounts

use hyperlane_sealevel_mailbox::mailbox_process_authority_pda_seeds;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::instruction as system_instruction;

use crate::{
    constants::{FEE_PAYER_SEED, HYPERLANE_MAILBOX_PROGRAM_ID, PENDING_SWAP_SEED},
    dispatcher,
    error::RouterError,
    types::PendingSwap,
};

const COMMIT_BODY_LEN: usize = 96;
const REVEAL_BODY_MIN_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Entry point from processor.rs
// ---------------------------------------------------------------------------

pub fn process_message_recipient<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: MessageRecipientInstruction,
) -> ProgramResult {
    match ix {
        MessageRecipientInstruction::InterchainSecurityModule => {
            // Return None — mailbox uses its default ISM
            let none: Option<Pubkey> = None;
            let encoded = borsh::to_vec(&none).map_err(|_| ProgramError::BorshIoError)?;
            set_return_data(&encoded);
            Ok(())
        }
        MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
            let empty: Vec<SerializableAccountMeta> = vec![];
            let ret = SimulationReturnData::new(empty);
            let encoded = borsh::to_vec(&ret).map_err(|_| ProgramError::BorshIoError)?;
            set_return_data(&encoded);
            Ok(())
        }
        MessageRecipientInstruction::Handle(handle) => {
            handle_dispatch(program_id, accounts, handle)
        }
        MessageRecipientInstruction::HandleAccountMetas(handle) => {
            handle_account_metas_dispatch(program_id, &handle)
        }
    }
}

// ---------------------------------------------------------------------------
// Handle — route by message body length
// ---------------------------------------------------------------------------

fn handle_dispatch<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    handle: HandleInstruction,
) -> ProgramResult {
    match handle.message.len() {
        COMMIT_BODY_LEN => handle_commit(program_id, accounts, handle),
        n if n >= REVEAL_BODY_MIN_LEN => handle_reveal(program_id, accounts, handle),
        _ => Err(RouterError::InvalidInputs.into()),
    }
}

// ---------------------------------------------------------------------------
// Commit handler
//
// Body (96 bytes): commitment(0..32) || salt(32..64) || recipient(64..96)
// ---------------------------------------------------------------------------

fn handle_commit<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    handle: HandleInstruction,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let process_authority = &accounts[0];
    let fee_payer = &accounts[1];
    let swap_info = &accounts[2];
    let system_prog = &accounts[3];

    // Verify the caller is the mailbox process authority PDA
    require_mailbox_process_authority(program_id, process_authority)?;

    let commitment: [u8; 32] = handle.message[0..32]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let recipient =
        Pubkey::try_from(&handle.message[64..96]).map_err(|_| RouterError::InvalidInputs)?;

    // Verify fee_payer is our program PDA
    let (fee_payer_key, fee_payer_bump) =
        Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    if *fee_payer.key != fee_payer_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Derive PDA from commitment — each unique commitment gets its own PDA,
    // so multiple in-flight swaps from the same sender can coexist.
    let origin_bytes = handle.origin.to_le_bytes();
    let sender_bytes = handle.sender.as_bytes();
    let (swap_key, swap_bump) = Pubkey::find_program_address(
        &[PENDING_SWAP_SEED, &origin_bytes, sender_bytes, &commitment],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Reject duplicate commits for the same commitment hash
    if !swap_info.data.borrow().is_empty() {
        return Err(RouterError::CommitmentAlreadySet.into());
    }

    // Create the pending_swap account
    let lamports = Rent::get()?.minimum_balance(PendingSwap::LEN);
    invoke_signed(
        &system_instruction::create_account(
            fee_payer.key,
            swap_info.key,
            lamports,
            PendingSwap::LEN as u64,
            program_id,
        ),
        &[fee_payer.clone(), swap_info.clone(), system_prog.clone()],
        &[
            &[FEE_PAYER_SEED, &[fee_payer_bump]],
            &[
                PENDING_SWAP_SEED,
                &origin_bytes,
                sender_bytes,
                &commitment,
                &[swap_bump],
            ],
        ],
    )?;

    let swap = PendingSwap {
        recipient,
        origin_domain: handle.origin,
        bump: swap_bump,
    };
    let mut data = swap_info.data.borrow_mut();
    swap.write_into(&mut data)?;

    msg!(
        "handle_commit: origin={} recipient={}",
        handle.origin,
        recipient
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Reveal handler
//
// Body: salt(0..32) || pda_token_ata(32..64) || borsh(cmds, inputs)(64..)
// ---------------------------------------------------------------------------

pub fn handle_reveal<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    handle: HandleInstruction,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let process_authority = &accounts[0];
    let fee_payer = &accounts[1];
    let swap_info = &accounts[2];
    let pda_ata_info = &accounts[3];
    let _system_prog = &accounts[4];
    let swap_accounts = &accounts[5..];

    require_mailbox_process_authority(program_id, process_authority)?;

    if handle.message.len() < REVEAL_BODY_MIN_LEN {
        return Err(RouterError::InvalidInputs.into());
    }
    let salt: [u8; 32] = handle.message[0..32]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let ata_in_body =
        Pubkey::try_from(&handle.message[32..64]).map_err(|_| RouterError::InvalidInputs)?;
    let cmd_bytes = &handle.message[64..];

    // Verify fee_payer PDA
    let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    if *fee_payer.key != fee_payer_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Compute commitment from reveal body — keccak256(borsh(cmds, inputs) || salt).
    // cmd_bytes is already the borsh encoding, so no round-trip needed.
    let commitment = {
        let mut preimage = cmd_bytes.to_vec();
        preimage.extend_from_slice(&salt);
        solana_program::keccak::hash(&preimage).to_bytes()
    };

    // Verify pending_swap PDA — PDA address is the commitment proof
    let origin_bytes = handle.origin.to_le_bytes();
    let sender_bytes = handle.sender.as_bytes();
    let (swap_key, _) = Pubkey::find_program_address(
        &[PENDING_SWAP_SEED, &origin_bytes, sender_bytes, &commitment],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Verify pda_token_ata matches what was declared in the reveal body
    if *pda_ata_info.key != ata_in_body {
        return Err(RouterError::InvalidInputs.into());
    }

    // Load pending_swap state
    let swap = {
        let data = swap_info.data.borrow();
        if data.is_empty() {
            return Err(RouterError::CommitmentMissing.into());
        }
        PendingSwap::from_bytes(&data)?
    };

    // Validate ATA ownership and non-zero balance
    {
        use solana_program::program_pack::Pack;
        let ata_data = pda_ata_info.data.borrow();
        let ata =
            spl_token::state::Account::unpack(&ata_data).map_err(|_| RouterError::InvalidInputs)?;
        if ata.owner != *swap_info.key {
            return Err(RouterError::InvalidRecipient.into());
        }
        if ata.amount == 0 {
            return Err(RouterError::InsufficientTokenBalance.into());
        }
    }

    let (swap_commands, swap_inputs): (Vec<u8>, Vec<Vec<u8>>) =
        borsh::from_slice(cmd_bytes).map_err(|_| RouterError::InvalidInputs)?;

    // Execute swap with pending_swap PDA as the signing authority
    let bump = swap.bump;
    let signer_seeds: &[&[u8]] = &[
        PENDING_SWAP_SEED,
        &origin_bytes,
        sender_bytes,
        &commitment,
        &[bump],
    ];
    let result = dispatcher::execute_commands(
        &swap_commands,
        &swap_inputs,
        swap_accounts,
        swap_info,
        0,
        &[signer_seeds],
    );
    if result.is_err() {
        msg!("Swap failed; tokens remain in PDA ATA — recipient calls ClosePendingSwap");
    }

    // Always close the pending_swap and return rent to fee_payer_pda
    let swap_lamports = swap_info.lamports();
    **swap_info.try_borrow_mut_lamports()? = 0;
    **fee_payer.try_borrow_mut_lamports()? += swap_lamports;
    swap_info.try_borrow_mut_data()?.fill(0);

    result.or(Ok(()))
}

// ---------------------------------------------------------------------------
// HandleAccountMetas
// ---------------------------------------------------------------------------

fn handle_account_metas_dispatch(program_id: &Pubkey, handle: &HandleInstruction) -> ProgramResult {
    if handle.message.len() == COMMIT_BODY_LEN {
        handle_account_metas_commit(program_id, handle)
    } else if handle.message.len() >= REVEAL_BODY_MIN_LEN {
        handle_account_metas_reveal(program_id, handle)
    } else {
        Err(RouterError::InvalidInputs.into())
    }
}

fn handle_account_metas_commit(program_id: &Pubkey, handle: &HandleInstruction) -> ProgramResult {
    let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    let origin_bytes = handle.origin.to_le_bytes();
    let commitment: [u8; 32] = handle.message[0..32]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let sender_bytes = handle.sender.as_bytes();
    let (swap_key, _) = Pubkey::find_program_address(
        &[PENDING_SWAP_SEED, &origin_bytes, sender_bytes, &commitment],
        program_id,
    );
    let metas: Vec<SerializableAccountMeta> = vec![
        SerializableAccountMeta {
            pubkey: fee_payer_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: swap_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: solana_system_interface::program::id(),
            is_signer: false,
            is_writable: false,
        },
    ];
    let encoded =
        borsh::to_vec(&SimulationReturnData::new(metas)).map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&encoded);
    Ok(())
}

pub fn handle_account_metas_reveal(
    program_id: &Pubkey,
    handle: &HandleInstruction,
) -> ProgramResult {
    if handle.message.len() < REVEAL_BODY_MIN_LEN {
        return Err(RouterError::InvalidInputs.into());
    }
    let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    let origin_bytes = handle.origin.to_le_bytes();
    let salt: [u8; 32] = handle.message[0..32]
        .try_into()
        .map_err(|_| RouterError::InvalidInputs)?;
    let pda_token_ata =
        Pubkey::try_from(&handle.message[32..64]).map_err(|_| RouterError::InvalidInputs)?;
    // Compute commitment from reveal body — mirrors handle_reveal's derivation
    let commitment = {
        let mut preimage = handle.message[64..].to_vec();
        preimage.extend_from_slice(&salt);
        solana_program::keccak::hash(&preimage).to_bytes()
    };
    let sender_bytes = handle.sender.as_bytes();
    let (swap_key, _) = Pubkey::find_program_address(
        &[PENDING_SWAP_SEED, &origin_bytes, sender_bytes, &commitment],
        program_id,
    );
    let metas: Vec<SerializableAccountMeta> = vec![
        SerializableAccountMeta {
            pubkey: fee_payer_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: swap_key,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: pda_token_ata,
            is_signer: false,
            is_writable: true,
        },
        SerializableAccountMeta {
            pubkey: solana_system_interface::program::id(),
            is_signer: false,
            is_writable: false,
        },
    ];
    let encoded =
        borsh::to_vec(&SimulationReturnData::new(metas)).map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&encoded);
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Verify that `account` is the Hyperlane mailbox process authority PDA for this program.
/// Seeds (from the mailbox program): ["hyperlane", "-", "process_authority", "-", recipient_program_id]
fn require_mailbox_process_authority(program_id: &Pubkey, account: &AccountInfo) -> ProgramResult {
    if !account.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    let (expected_pa, _) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(program_id),
        &HYPERLANE_MAILBOX_PROGRAM_ID,
    );
    if *account.key != expected_pa {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    Ok(())
}
