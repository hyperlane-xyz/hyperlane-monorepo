//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use std::str::FromStr as _;

use borsh::BorshSerialize;
use hyperlane_core::IsmType;
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const AUTHORITY: &str = "G9CdDjMs6dEd3Tv5eG2ZXo8iKksLRcbHTxpS41sEmX1g";

const ISM_TYPE: IsmType = IsmType::None;

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match InterchainSecurityModuleInstruction::decode(instruction_data)? {
        InterchainSecurityModuleInstruction::Verify(_) => {
            // TODO: this actually doesn't need to have *any* verification,
            // but whatever

            let accounts_iter = &mut accounts.iter();
            let hyperlane_mailbox_auth = next_account_info(accounts_iter)?;
            if hyperlane_mailbox_auth.key != &Pubkey::from_str(AUTHORITY).unwrap() {
                return Err(ProgramError::InvalidArgument);
            }
            if !hyperlane_mailbox_auth.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            if accounts_iter.next().is_some() {
                return Err(ProgramError::InvalidArgument);
            }
            msg!("hyperlane-sealevel-ism-rubber-stamp: LGTM!");
            Ok(())
        }
        InterchainSecurityModuleInstruction::Type => {
            set_return_data(
                &(ISM_TYPE as u32)
                    .try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
            );
            Ok(())
        }
    }
}
