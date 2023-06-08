//! Program processor.

use account_utils::DiscriminatorDecode;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction;
use hyperlane_sealevel_token_lib::{
    instruction::{Init, Instruction as TokenIxn, TransferFromRemote, TransferRemote},
    processor::HyperlaneSealevelToken,
};
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg, pubkey::Pubkey,
};

use crate::plugin::NativePlugin;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

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
                TransferFromRemote {
                    origin: handle.origin,
                    sender: handle.sender,
                    message: handle.message,
                },
            ),
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                transfer_from_remote_account_metas(
                    program_id,
                    accounts,
                    TransferFromRemote {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
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
        TokenIxn::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
        TokenIxn::SetInterchainSecurityModule(new_ism) => {
            set_interchain_security_module(program_id, accounts, new_ism)
        }
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the program.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [writable] The token PDA account.
/// 2. [writable] The dispatch authority PDA account.
/// 3. [signer] The payer and mailbox payer.
/// 4. [writable] The native collateral PDA account.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::initialize(program_id, accounts, init)
}

/// Transfers tokens to a remote.
/// Burns the tokens from the sender's associated token account and
/// then dispatches a message to the remote recipient.
///
/// Accounts:
/// 0.   [executable] The system program.
/// 1.   [executable] The spl_noop program.
/// 2.   [] The token PDA account.
/// 3.   [executable] The mailbox program.
/// 4.   [writeable] The mailbox outbox account.
/// 5.   [] Message dispatch authority.
/// 6.   [signer] The token sender and mailbox payer.
/// 7.   [signer] Unique message account.
/// 8.   [writeable] Message storage PDA.
/// 9.   [executable] The system program.
/// 10.  [writeable] The native token collateral PDA account.
fn transfer_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemote,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::transfer_remote(program_id, accounts, transfer)
}

/// Accounts:
/// 0.   [signer] Mailbox processor authority specific to this program.
/// 1.   [executable] system_program
/// 2.   [executable] spl_noop
/// 3.   [] hyperlane_token storage
/// 4.   [writeable] recipient wallet address
/// 5.   [executable] The system program.
/// 6.   [writeable] The native token collateral PDA account.
fn transfer_from_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferFromRemote,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::transfer_from_remote(program_id, accounts, transfer)
}

fn transfer_from_remote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferFromRemote,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::transfer_from_remote_account_metas(
        program_id, accounts, transfer,
    )
}

/// Enrolls a remote router.
///
/// Accounts:
/// 0. [writeable] The token PDA account.
/// 1. [signer] The owner.
fn enroll_remote_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: RemoteRouterConfig,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::enroll_remote_router(program_id, accounts, config)
}

/// Enrolls remote routers.
///
/// Accounts:
/// 0. [writeable] The token PDA account.
/// 1. [signer] The owner.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::enroll_remote_routers(program_id, accounts, configs)
}

/// Transfers ownership.
///
/// Accounts:
/// 0. [writeable] The token PDA account.
/// 1. [signer] The current owner.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::transfer_ownership(program_id, accounts, new_owner)
}

/// Gets the interchain security module, returning it as a serialized Option<Pubkey>.
///
/// Accounts:
/// 0. [] The token PDA account.
fn interchain_security_module(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::interchain_security_module(program_id, accounts)
}

/// Gets the account metas for getting the interchain security module.
///
/// Accounts:
///   None
fn interchain_security_module_account_metas(program_id: &Pubkey) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::interchain_security_module_account_metas(program_id)
}

/// Lets the owner set the interchain security module.
///
/// Accounts:
/// 0. [writeable] The token PDA account.
/// 1. [signer] The access control owner.
fn set_interchain_security_module(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_ism: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::set_interchain_security_module(
        program_id, accounts, new_ism,
    )
}
