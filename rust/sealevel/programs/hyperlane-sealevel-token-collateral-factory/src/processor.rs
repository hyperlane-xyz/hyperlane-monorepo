//! Program processor — factory-only, no legacy per-program instructions.

use crate::plugin::CollateralFactoryPlugin;
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
                HyperlaneSealevelToken::<CollateralFactoryPlugin>::interchain_security_module_for_factory(
                    program_id, accounts,
                )
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                HyperlaneSealevelToken::<CollateralFactoryPlugin>::interchain_security_module_account_metas_for_factory(
                    program_id,
                )
            }
            MessageRecipientInstruction::Handle(handle) => {
                HyperlaneSealevelToken::<CollateralFactoryPlugin>::transfer_from_remote_for_route(
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
                HyperlaneSealevelToken::<CollateralFactoryPlugin>::transfer_from_remote_account_metas_for_route(
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
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::init_factory(program_id, accounts, init)
        }
        TokenIxn::CreateRoute(create_route) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::create_route(
                program_id, accounts, create_route,
            )
        }
        TokenIxn::EnrollRemoteRoutersForRoute(data) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::enroll_remote_routers_for_route(
                program_id, accounts, data,
            )
        }
        TokenIxn::SetDestinationGasConfigsForRoute(data) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::set_destination_gas_configs_for_route(
                program_id, accounts, data,
            )
        }
        TokenIxn::SetInterchainSecurityModuleForRoute(data) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::set_interchain_security_module_for_route(
                program_id, accounts, &data.salt, data.value,
            )
        }
        TokenIxn::SetInterchainGasPaymasterForRoute(data) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::set_interchain_gas_paymaster_for_route(
                program_id, accounts, &data.salt, data.value,
            )
        }
        TokenIxn::TransferOwnershipForRoute(data) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::transfer_ownership_for_route(
                program_id, accounts, &data.salt, data.value,
            )
        }
        TokenIxn::TransferRemoteFromRoute(xfer) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::transfer_remote_from_route(
                program_id, accounts, xfer,
            )
        }
        TokenIxn::SetFactoryInterchainSecurityModule(ism) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::set_factory_interchain_security_module(
                program_id, accounts, ism,
            )
        }
        TokenIxn::TransferFactoryOwnership(new_owner) => {
            HyperlaneSealevelToken::<CollateralFactoryPlugin>::transfer_factory_ownership(
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
