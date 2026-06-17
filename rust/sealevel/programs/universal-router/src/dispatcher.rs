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
                signer_seeds,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        constants::MAX_SUB_PLAN_DEPTH,
        error::RouterError,
        types::{
            commands::{EXECUTE_SUB_PLAN, FLAG_ALLOW_REVERT, WRAP_SOL},
            WrapSolInput,
        },
    };
    use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

    fn make_authority<'a>(
        key: &'a Pubkey,
        lamports: &'a mut u64,
        data: &'a mut Vec<u8>,
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(
            key,
            true,
            false,
            lamports,
            data.as_mut_slice(),
            owner,
            false,
        )
    }

    // -----------------------------------------------------------------------
    // Validation: command/input length mismatch
    // -----------------------------------------------------------------------

    #[test]
    fn test_execute_commands_length_mismatch() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // 1 command, 0 inputs → mismatch
        let result = execute_commands(&[0x08], &[], &[], &authority, 0, &[]);
        assert_eq!(result, Err(RouterError::InvalidInputs.into()));
    }

    #[test]
    fn test_execute_commands_length_mismatch_reversed() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // 0 commands, 1 input → mismatch
        let result = execute_commands(&[], &[vec![]], &[], &authority, 0, &[]);
        assert_eq!(result, Err(RouterError::InvalidInputs.into()));
    }

    #[test]
    fn test_execute_commands_empty_is_ok() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        let result = execute_commands(&[], &[], &[], &authority, 0, &[]);
        assert!(result.is_ok());
    }

    // -----------------------------------------------------------------------
    // Unknown command
    // -----------------------------------------------------------------------

    #[test]
    fn test_execute_commands_unknown_command_reverts() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // 0x3F is beyond all valid command types and has no FLAG_ALLOW_REVERT
        let result = execute_commands(&[0x3F], &[vec![]], &[], &authority, 0, &[]);
        assert_eq!(result, Err(RouterError::UnknownCommand.into()));
    }

    #[test]
    fn test_execute_commands_flag_allow_revert_swallows_unknown_command() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // 0x3F | FLAG_ALLOW_REVERT(0x80) = 0xBF → unknown command, but error is swallowed
        let result = execute_commands(&[0xBF], &[vec![]], &[], &authority, 0, &[]);
        assert!(
            result.is_ok(),
            "FLAG_ALLOW_REVERT should swallow unknown command error"
        );
    }

    #[test]
    fn test_execute_commands_allow_revert_continues_to_next_command() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // Two commands: first fails with ALLOW_REVERT, second also fails with ALLOW_REVERT
        // Both should be swallowed → overall Ok
        let cmds = vec![0xBF, 0xBF];
        let inputs = vec![vec![], vec![]];
        let result = execute_commands(&cmds, &inputs, &[], &authority, 0, &[]);
        assert!(result.is_ok());
    }

    #[test]
    fn test_execute_commands_error_after_allow_revert_still_fails() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // First: ALLOW_REVERT + unknown → swallowed
        // Second: unknown without ALLOW_REVERT → returns error
        let cmds = vec![0xBF, 0x3F];
        let inputs = vec![vec![], vec![]];
        let result = execute_commands(&cmds, &inputs, &[], &authority, 0, &[]);
        assert_eq!(result, Err(RouterError::UnknownCommand.into()));
    }

    // -----------------------------------------------------------------------
    // Account partitioning (take_accounts)
    // -----------------------------------------------------------------------

    #[test]
    fn test_execute_commands_insufficient_accounts_for_wrap_sol() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        let wrap_input = WrapSolInput { amount: 100 };
        let input_bytes = borsh::to_vec(&wrap_input).unwrap();
        // WRAP_SOL needs 3 accounts but we pass 0
        let result = execute_commands(&[WRAP_SOL], &[input_bytes], &[], &authority, 0, &[]);
        assert_eq!(result, Err(RouterError::InsufficientAccounts.into()));
    }

    #[test]
    fn test_execute_commands_invalid_input_deserialization() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // WRAP_SOL with corrupt input bytes (too short to deserialize WrapSolInput)
        let result = execute_commands(&[WRAP_SOL], &[vec![0xAA]], &[], &authority, 0, &[]);
        assert_eq!(result, Err(RouterError::InvalidInputs.into()));
    }

    // -----------------------------------------------------------------------
    // EXECUTE_SUB_PLAN depth guard
    // -----------------------------------------------------------------------

    #[test]
    fn test_execute_sub_plan_depth_exceeded() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // Sub-plan with empty payload — depth check fires before deserialization
        let sub_payload: (Vec<u8>, Vec<Vec<u8>>) = (vec![], vec![]);
        let input = borsh::to_vec(&sub_payload).unwrap();

        let result = execute_commands(
            &[EXECUTE_SUB_PLAN],
            &[input],
            &[],
            &authority,
            MAX_SUB_PLAN_DEPTH,
            &[],
        );
        assert_eq!(result, Err(RouterError::SubPlanDepthExceeded.into()));
    }

    #[test]
    fn test_execute_sub_plan_below_max_depth_parses_ok() {
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let mut lamports = 0u64;
        let mut data = vec![];
        let authority = make_authority(&key, &mut lamports, &mut data, &owner);

        // Depth = 0 < MAX_SUB_PLAN_DEPTH(2): sub-plan with empty commands is Ok
        let sub_payload: (Vec<u8>, Vec<Vec<u8>>) = (vec![], vec![]);
        let input = borsh::to_vec(&sub_payload).unwrap();

        let result = execute_commands(&[EXECUTE_SUB_PLAN], &[input], &[], &authority, 0, &[]);
        assert!(result.is_ok(), "empty sub-plan at depth 0 should succeed");
    }
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
