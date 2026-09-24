//! Payment commands: WRAP_SOL (0x08), UNWRAP_WSOL (0x09), SWEEP (0x0a), TRANSFER (0x0b)

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::instruction as system_instruction;

use crate::{
    error::RouterError,
    modules::utils::{build_token_transfer_checked_ix, read_mint_decimals, read_token_amount},
    types::amount_sentinels::CONTRACT_BALANCE,
};

// ---------------------------------------------------------------------------
// WRAP_SOL (0x08)
//
// remaining_accounts (3):
//   [0] payer_wsol_ata   writable — authority's wSOL ATA (must be pre-created)
//   [1] token_program    — SPL Token program
//   [2] system_program
// ---------------------------------------------------------------------------
pub fn execute_wrap_sol<'info>(
    amount: u64,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let wsol_ata = &accounts[0];
    let token_program = &accounts[1];
    let _system_program = &accounts[2];

    let lamports = if amount == CONTRACT_BALANCE {
        authority
            .lamports()
            .checked_sub(Rent::get()?.minimum_balance(0))
            .ok_or(RouterError::Overflow)?
    } else {
        amount
    };

    invoke(
        &system_instruction::transfer(authority.key, wsol_ata.key, lamports),
        &[authority.clone(), wsol_ata.clone()],
    )?;

    let sync_ix = spl_token::instruction::sync_native(&spl_token::ID, wsol_ata.key)?;
    invoke(&sync_ix, &[wsol_ata.clone(), token_program.clone()])?;

    Ok(())
}

// ---------------------------------------------------------------------------
// UNWRAP_WSOL (0x09)
//
// remaining_accounts (3):
//   [0] wsol_ata         writable — wSOL ATA owned by authority
//   [1] recipient        writable — SOL destination
//   [2] token_program    — SPL Token program
// ---------------------------------------------------------------------------
pub fn execute_unwrap_wsol<'info>(
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let wsol_ata = &accounts[0];
    let recipient = &accounts[1];
    let token_program = &accounts[2];

    let close_ix = spl_token::instruction::close_account(
        token_program.key,
        wsol_ata.key,
        recipient.key,
        authority.key,
        &[],
    )?;
    invoke(
        &close_ix,
        &[
            wsol_ata.clone(),
            recipient.clone(),
            authority.clone(),
            token_program.clone(),
        ],
    )?;

    Ok(())
}

// ---------------------------------------------------------------------------
// SWEEP (0x0a)
//
// Transfers the entire balance of a token ATA to the recipient.
//
// remaining_accounts (4):
//   [0] src_ata          writable
//   [1] dst_ata          writable
//   [2] mint             readonly
//   [3] token_program
// ---------------------------------------------------------------------------
pub fn execute_sweep<'info>(
    amount_min: u64,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let src_ata = &accounts[0];
    let dst_ata = &accounts[1];
    let mint = &accounts[2];
    let token_program = &accounts[3];

    let balance = {
        let data = src_ata.data.borrow();
        read_token_amount(&data).map_err(|_| RouterError::InvalidInputs)?
    };

    if balance < amount_min {
        return Err(RouterError::InsufficientBalance.into());
    }
    if balance == 0 {
        return Ok(());
    }

    let decimals = {
        let data = mint.data.borrow();
        read_mint_decimals(&data).map_err(|_| RouterError::InvalidInputs)?
    };

    let transfer_ix = build_token_transfer_checked_ix(
        token_program.key,
        src_ata.key,
        mint.key,
        dst_ata.key,
        authority.key,
        balance,
        decimals,
    )?;
    let infos = [
        src_ata.clone(),
        mint.clone(),
        dst_ata.clone(),
        authority.clone(),
        token_program.clone(),
    ];
    if signer_seeds.is_empty() {
        invoke(&transfer_ix, &infos)?;
    } else {
        invoke_signed(&transfer_ix, &infos, signer_seeds)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// TRANSFER (0x0b)
//
// Transfers a specific amount of a token to the recipient.
//
// remaining_accounts (3):
//   [0] src_ata          writable
//   [1] dst_ata          writable
//   [2] token_program
// ---------------------------------------------------------------------------
pub fn execute_transfer<'info>(
    amount: u64,
    authority: &AccountInfo<'info>,
    accounts: &'info [AccountInfo<'info>],
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let src_ata = &accounts[0];
    let dst_ata = &accounts[1];
    let token_program = &accounts[2];

    let resolved = if amount == CONTRACT_BALANCE {
        let data = src_ata.data.borrow();
        read_token_amount(&data).map_err(|_| RouterError::InvalidInputs)?
    } else {
        amount
    };

    if resolved == 0 {
        return Ok(());
    }

    // TRANSFER is only used with SPL Token assets (USDC/USDT bridge tokens).
    let transfer_ix = spl_token::instruction::transfer(
        token_program.key,
        src_ata.key,
        dst_ata.key,
        authority.key,
        &[],
        resolved,
    )?;
    let infos = [
        src_ata.clone(),
        dst_ata.clone(),
        authority.clone(),
        token_program.clone(),
    ];
    if signer_seeds.is_empty() {
        invoke(&transfer_ix, &infos)?;
    } else {
        invoke_signed(&transfer_ix, &infos, signer_seeds)?;
    }

    Ok(())
}
