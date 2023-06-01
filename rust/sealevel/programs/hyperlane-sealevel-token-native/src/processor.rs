//! TODO

use borsh::BorshSerialize;
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction;
use hyperlane_sealevel_token_lib::{
    instruction::{Init, TransferFromRemote, TransferRemote},
    processor::HyperlaneSealevelToken,
};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg,
    program::set_return_data, program_error::ProgramError, pubkey::Pubkey,
};

use crate::{instruction::Instruction as TokenIxn, plugin::NativePlugin};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

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
                // Return None, indicating the default ISM should be used
                // TODO change this
                let ism: Option<Pubkey> = None;
                set_return_data(
                    &ism.try_to_vec()
                        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                );
                Ok(())
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                // No account metas are required, no return data necessary.
                Ok(())
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
    let token_instruction = TokenIxn::from_instruction_data(instruction_data).map_err(|err| {
        msg!("{}", err);
        err
    })?;
    match token_instruction {
        TokenIxn::Init(init) => initialize(program_id, accounts, init),
        TokenIxn::TransferRemote(xfer) => transfer_remote(program_id, accounts, xfer),
        TokenIxn::EnrollRemoteRouter(config) => enroll_remote_router(program_id, accounts, config),
        TokenIxn::EnrollRemoteRouters(configs) => {
            enroll_remote_routers(program_id, accounts, configs)
        }
        TokenIxn::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
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
/// 0. [executable] The spl_noop program.
/// 1. [] The token PDA account.
/// 2. [executable] The mailbox program.
/// 3. [writeable] The mailbox outbox account.
/// 4. [signer] The token sender.
/// 5. [executable] The system program.
/// 6. [writeable] The native token collateral PDA account.
fn transfer_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemote,
) -> ProgramResult {
    HyperlaneSealevelToken::<NativePlugin>::transfer_remote(program_id, accounts, transfer)
}

/// Accounts:
/// 0. [signer] Mailbox process authority specific to this program.
/// 1. [executable] system_program
/// 2. [executable] spl_noop
/// 3. [] hyperlane_token storage
/// 4. [] recipient wallet address
/// 5. [executable] The system program.
/// 6. [writeable] The native token collateral PDA account.
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
    let account_metas = HyperlaneSealevelToken::<NativePlugin>::transfer_from_remote_account_metas(
        program_id, accounts, transfer,
    )?;
    // Wrap it in the SimulationReturnData because serialized account_metas
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(account_metas)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
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
