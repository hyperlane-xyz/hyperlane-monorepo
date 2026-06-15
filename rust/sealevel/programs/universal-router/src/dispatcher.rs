//! Command dispatcher — mirrors Dispatcher.sol from the EVM universal-router.
//!
//! Iterates over the `commands` byte array and dispatches each command using
//! the corresponding slice of `remaining_accounts`. `FLAG_ALLOW_REVERT` (bit 7)
//! lets an individual command fail without reverting the whole transaction.
//!
//! Account partitioning: each command type consumes a fixed number of accounts
//! from `remaining_accounts` in order (counts defined in `constants::account_counts`).

use borsh::BorshDeserialize;
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, msg};

use crate::{
    constants::account_counts,
    error::RouterError,
    modules::{bridge, cross_chain, payments, raydium},
    types::{
        commands::*, BridgeTokenInput, ExecuteCrossChainInput, RaydiumAmmSwapInput,
        RaydiumClmmSwapInput, SweepInput, TransferInput, WrapSolInput,
    },
};

/// Dispatch all commands in sequence.
///
/// - `authority`     — the transaction signer (msg.sender equivalent)
/// - `signer_seeds`  — PDA seeds when authority is a PDA (passed to CPIs)
/// - `depth`         — sub-plan recursion guard (max = MAX_SUB_PLAN_DEPTH)
pub fn execute_commands<'info>(
    commands: &[u8],
    inputs: &[Vec<u8>],
    remaining: &'info [AccountInfo<'info>],
    authority: &AccountInfo<'info>,
    depth: u8,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if commands.len() != inputs.len() {
        return Err(RouterError::InvalidInputs.into());
    }

    let mut offset: usize = 0;

    for (i, &cmd_byte) in commands.iter().enumerate() {
        let allow_revert = (cmd_byte & FLAG_ALLOW_REVERT) != 0;
        let cmd = cmd_byte & COMMAND_TYPE_MASK;

        let result = dispatch_one(
            cmd,
            &inputs[i],
            remaining,
            &mut offset,
            authority,
            depth,
            signer_seeds,
        );

        match result {
            Ok(()) => {}
            Err(e) if allow_revert => {
                msg!(
                    "Command 0x{:02x} failed (FLAG_ALLOW_REVERT set): {:?}",
                    cmd,
                    e
                );
            }
            Err(e) => return Err(e),
        }
    }

    Ok(())
}

fn dispatch_one<'info>(
    cmd: u8,
    input: &[u8],
    remaining: &'info [AccountInfo<'info>],
    offset: &mut usize,
    authority: &AccountInfo<'info>,
    depth: u8,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    match cmd {
        RAYDIUM_CLMM_SWAP_EXACT_IN => {
            let inp = RaydiumClmmSwapInput::try_from_slice(input)
                .map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(
                remaining,
                offset,
                account_counts::RAYDIUM_CLMM_SWAP_EXACT_IN,
            )?;
            raydium::execute_raydium_clmm_swap_exact_in(
                inp.amount_in,
                inp.amount_out_minimum,
                inp.sqrt_price_limit_x64,
                inp.is_base_input,
                authority,
                accs,
            )
        }

        RAYDIUM_AMM_SWAP_EXACT_IN => {
            let inp = RaydiumAmmSwapInput::try_from_slice(input)
                .map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(remaining, offset, account_counts::RAYDIUM_AMM_SWAP_EXACT_IN)?;
            raydium::execute_raydium_amm_swap_exact_in(
                inp.amount_in,
                inp.amount_out_minimum,
                authority,
                accs,
            )
        }

        WRAP_SOL => {
            let inp =
                WrapSolInput::try_from_slice(input).map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(remaining, offset, account_counts::WRAP_SOL)?;
            payments::execute_wrap_sol(inp.amount, authority, accs)
        }

        UNWRAP_WSOL => {
            let accs = take_accounts(remaining, offset, account_counts::UNWRAP_WSOL)?;
            payments::execute_unwrap_wsol(authority, accs)
        }

        SWEEP => {
            let inp = SweepInput::try_from_slice(input).map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(remaining, offset, account_counts::SWEEP)?;
            payments::execute_sweep(inp.amount_min, authority, accs, signer_seeds)
        }

        TRANSFER => {
            let inp =
                TransferInput::try_from_slice(input).map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(remaining, offset, account_counts::TRANSFER)?;
            payments::execute_transfer(inp.amount, authority, accs, signer_seeds)
        }

        BRIDGE_TOKEN => {
            let inp =
                BridgeTokenInput::try_from_slice(input).map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(remaining, offset, account_counts::BRIDGE_TOKEN)?;
            bridge::execute_bridge_token(
                inp.bridge_type,
                inp.destination_domain,
                inp.recipient,
                inp.amount,
                inp.msg_fee,
                authority,
                accs,
            )
        }

        EXECUTE_CROSS_CHAIN => {
            let inp = ExecuteCrossChainInput::try_from_slice(input)
                .map_err(|_| RouterError::InvalidInputs)?;
            let accs = take_accounts(remaining, offset, account_counts::EXECUTE_CROSS_CHAIN)?;
            cross_chain::execute_cross_chain(
                inp.destination_domain,
                inp.ica_router,
                inp.ism,
                inp.commitment,
                inp.commit_msg_fee,
                inp.reveal_msg_fee,
                authority,
                accs,
            )
        }

        EXECUTE_SUB_PLAN => {
            if depth >= crate::constants::MAX_SUB_PLAN_DEPTH {
                return Err(RouterError::SubPlanDepthExceeded.into());
            }
            let (sub_commands, sub_inputs): (Vec<u8>, Vec<Vec<u8>>) =
                borsh::from_slice(input).map_err(|_| RouterError::InvalidInputs)?;
            let remaining_for_sub = &remaining[*offset..];
            let mut sub_offset: usize = 0;
            execute_commands_inner(
                &sub_commands,
                &sub_inputs,
                remaining_for_sub,
                &mut sub_offset,
                authority,
                depth + 1,
                signer_seeds,
            )?;
            *offset += sub_offset;
            Ok(())
        }

        _ => Err(RouterError::UnknownCommand.into()),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn take_accounts<'info>(
    remaining: &'info [AccountInfo<'info>],
    offset: &mut usize,
    n: usize,
) -> Result<&'info [AccountInfo<'info>], solana_program::program_error::ProgramError> {
    if *offset + n > remaining.len() {
        return Err(RouterError::InsufficientAccounts.into());
    }
    let slice = &remaining[*offset..*offset + n];
    *offset += n;
    Ok(slice)
}

/// Internal variant used by EXECUTE_SUB_PLAN to share the offset pointer.
fn execute_commands_inner<'info>(
    commands: &[u8],
    inputs: &[Vec<u8>],
    remaining: &'info [AccountInfo<'info>],
    offset: &mut usize,
    authority: &AccountInfo<'info>,
    depth: u8,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    if commands.len() != inputs.len() {
        return Err(RouterError::InvalidInputs.into());
    }
    for (i, &cmd_byte) in commands.iter().enumerate() {
        let allow_revert = (cmd_byte & FLAG_ALLOW_REVERT) != 0;
        let cmd = cmd_byte & COMMAND_TYPE_MASK;
        let result = dispatch_one(
            cmd,
            &inputs[i],
            remaining,
            offset,
            authority,
            depth,
            signer_seeds,
        );
        match result {
            Ok(()) => {}
            Err(e) if allow_revert => {
                msg!(
                    "Sub-plan command 0x{:02x} failed (FLAG_ALLOW_REVERT): {:?}",
                    cmd,
                    e
                );
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
