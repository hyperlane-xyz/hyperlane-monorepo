//! Program processor.

use account_utils::DiscriminatorDecode;
use hyperlane_sealevel_connection_client::{
    gas_router::GasRouterConfig, router::RemoteRouterConfig,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_lib::{
    instruction::{Init, Instruction as TokenIxn, TransferRemote},
    processor::HyperlaneSealevelToken,
};
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, msg, pubkey::Pubkey};
use std::collections::HashMap;

use crate::instruction::CctpTokenInstruction;
use crate::plugin::CctpPlugin;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Processes an instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // First, check if the instruction has a discriminant relating to
    // the message recipient interface.
    if let Ok(message_recipient_instruction) = MessageRecipientInstruction::decode(instruction_data)
    {
        return match message_recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                interchain_security_module(program_id, accounts)
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                interchain_security_module_account_metas(program_id)
            }
            MessageRecipientInstruction::Handle(handle) => transfer_from_remote(
                program_id,
                accounts,
                HandleInstruction {
                    origin: handle.origin,
                    sender: handle.sender,
                    message: handle.message,
                },
            ),
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                transfer_from_remote_account_metas(
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

    // Check if it's a CCTP-specific instruction
    if let Ok(cctp_instruction) = CctpTokenInstruction::decode(instruction_data) {
        return match cctp_instruction {
            CctpTokenInstruction::AddDomainMappings { mappings } => {
                add_domain_mappings(program_id, accounts, mappings)
            }
        };
    }

    // Otherwise, try decoding a "normal" token instruction
    match TokenIxn::decode(instruction_data)? {
        TokenIxn::Init(init) => initialize(program_id, accounts, init),
        TokenIxn::TransferRemote(xfer) => transfer_remote(program_id, accounts, xfer),
        TokenIxn::EnrollRemoteRouter(config) => enroll_remote_router(program_id, accounts, config),
        TokenIxn::EnrollRemoteRouters(configs) => {
            enroll_remote_routers(program_id, accounts, configs)
        }
        TokenIxn::SetDestinationGasConfigs(configs) => {
            set_destination_gas_configs(program_id, accounts, configs)
        }
        TokenIxn::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
        TokenIxn::SetInterchainSecurityModule(new_ism) => {
            set_interchain_security_module(program_id, accounts, new_ism)
        }
        TokenIxn::SetInterchainGasPaymaster(new_igp) => {
            set_interchain_gas_paymaster(program_id, accounts, new_igp)
        }
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the program.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::initialize(program_id, accounts, init)
}

/// Transfers tokens to a remote chain using CCTP's depositForBurn.
/// The CctpPlugin handles the CCTP-specific logic for burning tokens
/// and creating the CCTP message.
fn transfer_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemote,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_remote(program_id, accounts, transfer)
}

/// Transfers tokens from a remote.
fn transfer_from_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_from_remote(program_id, accounts, transfer)
}

/// Gets the account metas for a `transfer_from_remote` instruction.
fn transfer_from_remote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_from_remote_account_metas(
        program_id, accounts, transfer,
    )
}

/// Enrolls a remote router.
fn enroll_remote_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: RemoteRouterConfig,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::enroll_remote_router(program_id, accounts, config)
}

/// Enrolls remote routers.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::enroll_remote_routers(program_id, accounts, configs)
}

/// Sets the destination gas configs.
fn set_destination_gas_configs(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<GasRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::set_destination_gas_configs(program_id, accounts, configs)
}

/// Transfers ownership.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_ownership(program_id, accounts, new_owner)
}

/// Gets the interchain security module.
fn interchain_security_module(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::interchain_security_module(program_id, accounts)
}

/// Gets the account metas for getting the interchain security module.
fn interchain_security_module_account_metas(program_id: &Pubkey) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::interchain_security_module_account_metas(program_id)
}

/// Sets the interchain security module.
fn set_interchain_security_module(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_ism: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::set_interchain_security_module(
        program_id, accounts, new_ism,
    )
}

/// Sets the interchain gas paymaster.
fn set_interchain_gas_paymaster(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_igp: Option<(Pubkey, InterchainGasPaymasterType)>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::set_interchain_gas_paymaster(
        program_id, accounts, new_igp,
    )
}

// CCTP-specific functions

/// Adds or updates domain mappings.
///
/// Accounts:
/// 0. `[writable]` The token PDA account.
/// 1. `[signer]` The owner.
fn add_domain_mappings(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    mappings: HashMap<u32, u32>,
) -> ProgramResult {
    // TODO: Implement domain mapping updates
    msg!("Adding domain mappings: {:?}", mappings);
    Ok(())
}
