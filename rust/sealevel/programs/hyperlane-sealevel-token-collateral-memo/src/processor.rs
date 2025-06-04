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
    instruction::{
        DymInstruction, Init, Instruction as TokenIxn, TransferRemote, TransferRemoteMemo,
    },
    processor::HyperlaneSealevelToken,
};
use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, msg, pubkey::Pubkey};

use crate::plugin::CollateralPlugin;

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
    if let Ok(instr) = DymInstruction::decode(instruction_data) {
        return match instr {
            DymInstruction::TransferRemoteMemo(xfer) => {
                transfer_remote_memo(program_id, accounts, xfer)
            }
        }
        .map_err(|err| {
            msg!("{}", err);
            err
        });
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

fn transfer_remote_memo(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemoteMemo,
) -> ProgramResult {
    let base = transfer.base;
    let memo = transfer.memo;
    HyperlaneSealevelToken::<CollateralPlugin>::transfer_remote_memo(
        program_id, accounts, base, memo,
    )
}

/// Initializes the program.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writable]` The token PDA account.
/// 2. `[writable]` The dispatch authority PDA account.
/// 3. `[signer]` The payer and access control owner of the program.
/// 4. `[executable]` The SPL token program for the mint, i.e. either SPL token program or the 2022 version.
/// 5. `[]` The mint.
/// 6. `[executable]` The Rent sysvar program.
/// 7. `[writable]` The escrow PDA account.
/// 8. `[writable]` The ATA payer PDA account.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::initialize(program_id, accounts, init)
}

/// Transfers tokens to a remote.
/// Transfers the collateral token into the escrow PDA account and
/// then dispatches a message to the remote recipient.
///
/// Accounts:
/// 0.   `[executable]` The system program.
/// 1.   `[executable]` The spl_noop program.
/// 2.   `[]` The token PDA account.
/// 3.   `[executable]` The mailbox program.
/// 4.   `[writeable]` The mailbox outbox account.
/// 5.   `[]` Message dispatch authority.
/// 6.   `[signer]` The token sender and mailbox payer.
/// 7.   `[signer]` Unique message / gas payment account.
/// 8.   `[writeable]` Message storage PDA.
///      ---- If using an IGP ----
/// 9.   `[executable]` The IGP program.
/// 10.  `[writeable]` The IGP program data.
/// 11.  `[writeable]` Gas payment PDA.
/// 12.  `[]` OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
/// 13.  `[writeable]` The IGP account.
///      ---- End if ----
/// 14.  `[executable]` The SPL token program for the mint.
/// 15.  `[writeable]` The mint.
/// 16.  `[writeable]` The token sender's associated token account, from which tokens will be sent.
/// 17.  `[writeable]` The escrow PDA account.
fn transfer_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemote,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::transfer_remote(program_id, accounts, transfer)
}

// Accounts:
// 0. `[signer]` Mailbox process authority specific to this program.
// 1. `[executable]` system_program
// 2. `[]` hyperlane_token storage
// 3. `[]` recipient wallet address
// 4. `[executable]` SPL token 2022 program.
// 5. `[executable]` SPL associated token account.
// 6. `[writeable]` Mint account.
// 7. `[writeable]` Recipient associated token account.
// 8. `[writeable]` ATA payer PDA account.
// 9. `[writeable]` Escrow account.
fn transfer_from_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::transfer_from_remote(program_id, accounts, transfer)
}

/// Gets the account metas for a `transfer_from_remote` instruction.
///
/// Accounts:
///   None
fn transfer_from_remote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::transfer_from_remote_account_metas(
        program_id, accounts, transfer,
    )
}

/// Enrolls a remote router.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The token PDA account.
/// 2. `[signer]` The owner.
fn enroll_remote_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: RemoteRouterConfig,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::enroll_remote_router(program_id, accounts, config)
}

/// Enrolls remote routers.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The token PDA account.
/// 2. `[signer]` The owner.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::enroll_remote_routers(program_id, accounts, configs)
}

/// Sets the destination gas configs.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The token PDA account.
/// 2. `[signer]` The owner.
fn set_destination_gas_configs(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<GasRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::set_destination_gas_configs(
        program_id, accounts, configs,
    )
}

/// Transfers ownership.
///
/// Accounts:
/// 0. `[writeable]` The token PDA account.
/// 1. `[signer]` The current owner.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::transfer_ownership(program_id, accounts, new_owner)
}

/// Gets the interchain security module, returning it as a serialized Option<Pubkey>.
///
/// Accounts:
/// 0. `[]` The token PDA account.
fn interchain_security_module(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::interchain_security_module(program_id, accounts)
}

/// Gets the account metas for getting the interchain security module.
///
/// Accounts:
///   None
fn interchain_security_module_account_metas(program_id: &Pubkey) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::interchain_security_module_account_metas(program_id)
}

/// Lets the owner set the interchain security module.
///
/// Accounts:
/// 0. `[writeable]` The token PDA account.
/// 1. `[signer]` The access control owner.
fn set_interchain_security_module(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_ism: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::set_interchain_security_module(
        program_id, accounts, new_ism,
    )
}

/// Lets the owner set the interchain gas paymaster.
///
/// Accounts:
/// 0. `[writeable]` The token PDA account.
/// 1. `[signer]` The access control owner.
fn set_interchain_gas_paymaster(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_igp: Option<(Pubkey, InterchainGasPaymasterType)>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CollateralPlugin>::set_interchain_gas_paymaster(
        program_id, accounts, new_igp,
    )
}
