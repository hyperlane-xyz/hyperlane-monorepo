//! Program processor — factory-only, no legacy per-program instructions.

use crate::plugin::NativeFactoryPlugin;
use account_utils::DiscriminatorDecode;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_lib::{
    instruction::Instruction as TokenIxn, processor::HyperlaneSealevelToken,
};
use solana_program::{
    account_info::AccountInfo, entrypoint::ProgramResult, msg, program_error::ProgramError,
    pubkey::Pubkey,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Processes an instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(ix) = MessageRecipientInstruction::decode(instruction_data) {
        return match ix {
            MessageRecipientInstruction::InterchainSecurityModule => {
                HyperlaneSealevelToken::<NativeFactoryPlugin>::interchain_security_module_for_factory(
                    program_id, accounts,
                )
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                HyperlaneSealevelToken::<NativeFactoryPlugin>::interchain_security_module_account_metas_for_factory(
                    program_id,
                )
            }
            MessageRecipientInstruction::Handle(handle) => {
                HyperlaneSealevelToken::<NativeFactoryPlugin>::transfer_from_remote_for_route(
                    program_id,
                    accounts,
                    HandleInstruction {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
            }
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                HyperlaneSealevelToken::<NativeFactoryPlugin>::transfer_from_remote_account_metas_for_route(
                    program_id,
                    accounts,
                    HandleInstruction {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
            }
        };
    }

    match TokenIxn::decode(instruction_data)? {
        TokenIxn::InitFactory(init) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::init_factory(program_id, accounts, init)
        }
        TokenIxn::CreateRoute(create_route) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::create_route(
                program_id,
                accounts,
                create_route,
            )
        }
        TokenIxn::EnrollRemoteRoutersForRoute(data) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::enroll_remote_routers_for_route(
                program_id, accounts, data,
            )
        }
        TokenIxn::SetDestinationGasConfigsForRoute(data) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::set_destination_gas_configs_for_route(
                program_id, accounts, data,
            )
        }
        TokenIxn::SetInterchainSecurityModuleForRoute(data) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::set_interchain_security_module_for_route(
                program_id, accounts, &data.salt, data.value,
            )
        }
        TokenIxn::SetInterchainGasPaymasterForRoute(data) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::set_interchain_gas_paymaster_for_route(
                program_id, accounts, &data.salt, data.value,
            )
        }
        TokenIxn::TransferOwnershipForRoute(data) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::transfer_ownership_for_route(
                program_id, accounts, &data.salt, data.value,
            )
        }
        TokenIxn::TransferRemoteFromRoute(xfer) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::transfer_remote_from_route(
                program_id, accounts, xfer,
            )
        }
        TokenIxn::SetFactoryInterchainSecurityModule(ism) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::set_factory_interchain_security_module(
                program_id, accounts, ism,
            )
        }
        TokenIxn::TransferFactoryOwnership(new_owner) => {
            HyperlaneSealevelToken::<NativeFactoryPlugin>::transfer_factory_ownership(
                program_id, accounts, new_owner,
            )
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}
