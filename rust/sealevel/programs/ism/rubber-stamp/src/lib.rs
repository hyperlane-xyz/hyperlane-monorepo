//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use borsh::BorshSerialize;
use hyperlane_core::IsmType;
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg,
    program::set_return_data, program_error::ProgramError, pubkey::Pubkey,
};

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const ISM_TYPE: IsmType = IsmType::None;

pub fn process_instruction(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match InterchainSecurityModuleInstruction::decode(instruction_data)? {
        InterchainSecurityModuleInstruction::Verify(_) => {
            msg!("hyperlane-sealevel-ism-rubber-stamp: LGTM!");
            Ok(())
        }
        InterchainSecurityModuleInstruction::VerifyAccountMetas(_) => {
            // No accounts needed!
            Ok(())
        }
        InterchainSecurityModuleInstruction::Type => {
            set_return_data(
                &SimulationReturnData::new(ISM_TYPE as u32)
                    .try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
            );
            Ok(())
        }
    }
}
