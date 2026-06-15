//! Top-level instruction router.

use hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction;
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, keccak, msg,
    pubkey::Pubkey, sysvar::Sysvar,
};

use crate::{
    constants::{FEE_PAYER_SEED, PENDING_SWAP_SEED},
    dispatcher,
    error::RouterError,
    hyperlane,
    instruction::{
        ClosePendingSwapIxn, ExecuteIxn, ExecuteWithDeadlineIxn, RevealIxn, RouterInstruction,
    },
    types::PendingSwap,
};

pub fn process<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    instruction_data: &[u8],
) -> ProgramResult {
    // Hyperlane mailbox calls come first — fixed discriminators, must not collide.
    if let Ok(msg_ix) = MessageRecipientInstruction::decode(instruction_data) {
        return hyperlane::process_message_recipient(program_id, accounts, msg_ix);
    }

    match RouterInstruction::from_instruction_data(instruction_data)? {
        RouterInstruction::Execute(ix) => execute(program_id, accounts, ix),
        RouterInstruction::ExecuteWithDeadline(ix) => {
            execute_with_deadline(program_id, accounts, ix)
        }
        RouterInstruction::Reveal(ix) => reveal(program_id, accounts, ix),
        RouterInstruction::ClosePendingSwap(ix) => close_pending_swap(program_id, accounts, ix),
    }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

fn execute<'info>(
    _program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ExecuteIxn,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let authority = &accounts[0];
    if !authority.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    let remaining = &accounts[2..];
    dispatcher::execute_commands(&ix.commands, &ix.inputs, remaining, authority, 0, &[])
}

fn execute_with_deadline<'info>(
    _program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ExecuteWithDeadlineIxn,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let authority = &accounts[0];
    if !authority.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }
    let clock = Clock::get()?;
    if clock.unix_timestamp > ix.deadline {
        return Err(RouterError::DeadlinePassed.into());
    }
    let remaining = &accounts[2..];
    dispatcher::execute_commands(&ix.commands, &ix.inputs, remaining, authority, 0, &[])
}

// ---------------------------------------------------------------------------
// Reveal (direct — not via Hyperlane mailbox)
// ---------------------------------------------------------------------------
//
// Accounts:
//   [0] payer              writable signer
//   [1] pending_swap PDA   writable
//   [2] pda_token_ata      writable
//   [3] fee_payer_pda      writable (receives pending_swap rent on close)
//   [4] system_program
//   [5..] swap command accounts

pub fn reveal<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: RevealIxn,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let _payer = &accounts[0];
    let swap_info = &accounts[1];
    let pda_ata_info = &accounts[2];
    let fee_payer_pda = &accounts[3];
    let swap_accounts = &accounts[5..];

    // Compute commitment and verify pending_swap PDA address
    let origin_bytes = ix.origin.to_le_bytes();
    let commitment = {
        let mut preimage = ix.message.clone();
        preimage.extend_from_slice(&ix.salt);
        keccak::hash(&preimage).to_bytes()
    };
    let (swap_key, swap_bump) = Pubkey::find_program_address(
        &[PENDING_SWAP_SEED, &origin_bytes, &ix.sender, &commitment],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Verify fee_payer_pda
    let (fee_payer_key, _) = Pubkey::find_program_address(&[FEE_PAYER_SEED], program_id);
    if *fee_payer_pda.key != fee_payer_key {
        return Err(RouterError::InvalidInputs.into());
    }

    if swap_info.data.borrow().is_empty() {
        return Err(RouterError::CommitmentMissing.into());
    }

    // Verify pda_token_ata ownership and non-zero balance
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

    // Decode swap payload: borsh((Vec<u8>, Vec<Vec<u8>>))
    let (swap_commands, swap_inputs): (Vec<u8>, Vec<Vec<u8>>) =
        borsh::from_slice(&ix.message).map_err(|_| RouterError::InvalidInputs)?;

    // Execute with pending_swap PDA as signing authority
    // PDA address already proves the commitment — no separate hash check needed
    let bump_bytes = [swap_bump];
    let signer_seeds: &[&[u8]] = &[
        PENDING_SWAP_SEED,
        &origin_bytes,
        ix.sender.as_ref(),
        &commitment,
        &bump_bytes,
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

    // Close the pending_swap account and return rent to fee_payer_pda
    let swap_lamports = swap_info.lamports();
    **swap_info.try_borrow_mut_lamports()? = 0;
    **fee_payer_pda.try_borrow_mut_lamports()? += swap_lamports;
    swap_info.try_borrow_mut_data()?.fill(0);

    result.or(Ok(()))
}

// ---------------------------------------------------------------------------
// ClosePendingSwap
// ---------------------------------------------------------------------------
//
// Accounts:
//   [0] pending_swap PDA   writable (closed; rent → recipient)
//   [1] recipient          writable signer
//   [2] system_program

fn close_pending_swap<'info>(
    program_id: &Pubkey,
    accounts: &'info [AccountInfo<'info>],
    ix: ClosePendingSwapIxn,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let swap_info = &accounts[0];
    let recipient = &accounts[1];

    if !recipient.is_signer {
        return Err(RouterError::UnauthorizedMailbox.into());
    }

    // Verify PDA
    let origin_bytes = ix.origin.to_le_bytes();
    let (swap_key, _) = Pubkey::find_program_address(
        &[PENDING_SWAP_SEED, &origin_bytes, &ix.sender, &ix.commitment],
        program_id,
    );
    if *swap_info.key != swap_key {
        return Err(RouterError::InvalidInputs.into());
    }

    // Verify stored recipient matches signer
    {
        let data = swap_info.data.borrow();
        if data.is_empty() {
            return Err(RouterError::InvalidInputs.into());
        }
        let swap = PendingSwap::from_bytes(&data)?;
        if swap.recipient != *recipient.key {
            return Err(RouterError::InvalidRecipient.into());
        }
    }

    // Transfer lamports from pending_swap to recipient
    let swap_lamports = swap_info.lamports();
    **swap_info.try_borrow_mut_lamports()? = 0;
    **recipient.try_borrow_mut_lamports()? += swap_lamports;
    swap_info.try_borrow_mut_data()?.fill(0);

    Ok(())
}
