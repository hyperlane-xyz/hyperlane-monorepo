//! Mailbox-authenticated execution and outbound dispatch.

use account_utils::{create_pda_account, verify_account_uninitialized, SizedData};
use borsh::BorshDeserialize;
use hyperlane_core::H256;
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_loader_v3_interface::{get_program_data_address, state::UpgradeableLoaderState};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{
        config_address, interchain_account_address, RouterConfig, RouterConfigAccount, CONFIG_SEED,
    },
    instruction::{CallRemoteWithOverrides, Instruction as RouterInstruction},
    interchain_account_seeds,
    message::{Call, InterchainAccountMessage, SealevelCallData},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Version-query marker.
pub struct InterchainAccountRouterProgram;
impl package_versioned::PackageVersioned for InterchainAccountRouterProgram {}

/// Router program entrypoint.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if package_versioned::is_get_program_version(data) {
        return package_versioned::process_get_program_version::<InterchainAccountRouterProgram>();
    }
    if let Ok(instruction) = MessageRecipientInstruction::decode(data) {
        return match instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                // Dynamic, message-selected ISMs are deliberately unsupported for now.
                set_return_data(&borsh::to_vec(&Option::<Pubkey>::None)?);
                Ok(())
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                return_metas(vec![])
            }
            MessageRecipientInstruction::Handle(handle) => {
                handle_message(program_id, accounts, handle)
            }
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                return_metas(handle_account_metas(program_id, &handle)?)
            }
        };
    }
    match RouterInstruction::try_from_slice(data)
        .map_err(|_| ProgramError::InvalidInstructionData)?
    {
        RouterInstruction::Init => initialize(program_id, accounts),
        RouterInstruction::CallRemoteWithOverrides(call) => call_remote(program_id, accounts, call),
    }
}

/// Accounts: system, payer, config, canonical loader ProgramData, upgrade authority, mailbox.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [system, payer, config, program_data, authority, mailbox] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (key, bump) = config_address(program_id);
    if system.key != &system_program::ID || config.key != &key || !mailbox.executable {
        return Err(ProgramError::InvalidArgument);
    }
    if !payer.is_signer || !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if program_data.key != &get_program_data_address(program_id)
        || program_data.owner != &solana_sdk_ids::bpf_loader_upgradeable::ID
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let state = bincode::deserialize(&program_data.try_borrow_data()?)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(expected),
            ..
        } if expected == *authority.key => {}
        _ => return Err(ProgramError::MissingRequiredSignature),
    }
    verify_account_uninitialized(config)?;
    let state = RouterConfigAccount::from(RouterConfig {
        mailbox: *mailbox.key,
    });
    create_pda_account(
        payer,
        &Rent::get()?,
        state.size(),
        program_id,
        system,
        config,
        &[CONFIG_SEED, &[bump]],
    )?;
    state.store(config, false)?;
    msg!("Initialized ICA router with mailbox {}", mailbox.key);
    Ok(())
}

fn incoming_message(data: &[u8]) -> Result<InterchainAccountMessage, ProgramError> {
    let message = InterchainAccountMessage::decode(data)?;
    if message.ism != H256::zero() {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(message)
}

fn native_instruction(call: Call, ica: &Pubkey) -> Result<Instruction, ProgramError> {
    if !call.value.is_zero() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let data = SealevelCallData::try_from_slice(&call.data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    // Never lend the relayer's or mailbox's signature to remote code. Even an
    // account signed elsewhere in the transaction must not become an ICA signer.
    if data
        .accounts
        .iter()
        .any(|meta| meta.is_signer && &meta.pubkey != ica)
    {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(Instruction {
        program_id: Pubkey::new_from_array(call.to.0),
        accounts: data.accounts.into_iter().map(Into::into).collect(),
        data: data.data,
    })
}

/// Returns the config, ICA authority, and deduplicated target accounts for Handle.
/// The mailbox prepends its process authority, as for Hyp token handlers.
/// Each CPI restores its own authenticated account order and privileges.
pub fn handle_account_metas(
    program_id: &Pubkey,
    handle: &HandleInstruction,
) -> Result<Vec<AccountMeta>, ProgramError> {
    let body = incoming_message(&handle.message)?;
    let (ica, _) = interchain_account_address(
        program_id,
        handle.origin,
        &body.owner,
        &handle.sender,
        &body.ism,
        &body.salt,
    );
    let mut metas = vec![
        AccountMeta::new_readonly(config_address(program_id).0, false),
        AccountMeta::new_readonly(ica, false),
    ];
    for call in body.calls {
        let instruction = native_instruction(call, &ica)?;
        for mut meta in std::iter::once(AccountMeta::new_readonly(instruction.program_id, false))
            .chain(instruction.accounts)
        {
            meta.is_signer = false;
            if let Some(existing) = metas
                .iter_mut()
                .find(|existing| existing.pubkey == meta.pubkey)
            {
                existing.is_writable |= meta.is_writable;
            } else {
                metas.push(meta);
            }
        }
    }
    Ok(metas)
}

fn return_metas(metas: Vec<AccountMeta>) -> ProgramResult {
    let metas: Vec<SerializableAccountMeta> = metas.into_iter().map(Into::into).collect();
    set_return_data(&borsh::to_vec(&SimulationReturnData::new(metas))?);
    Ok(())
}

/// Authenticates the mailbox and executes the batch atomically during delivery.
/// Calls back into the active mailbox are unsupported: Solana rejects indirect
/// reentrancy, including outbound dispatch through this router or a warp route.
fn handle_message(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let [process_authority, config, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let config = RouterConfig::load(program_id, config)?;
    let (expected, _) = Pubkey::find_program_address(
        mailbox_process_authority_pda_seeds!(program_id),
        &config.mailbox,
    );
    if process_authority.key != &expected {
        return Err(ProgramError::InvalidArgument);
    }
    if !process_authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let body = incoming_message(&handle.message)?;
    let (ica, bump) = interchain_account_address(
        program_id,
        handle.origin,
        &body.owner,
        &handle.sender,
        &body.ism,
        &body.salt,
    );
    if authority.key != &ica {
        return Err(ProgramError::InvalidArgument);
    }
    let seeds = interchain_account_seeds!(
        handle.origin,
        body.owner,
        handle.sender,
        body.ism,
        body.salt,
        bump
    );
    for call in body.calls {
        let instruction = native_instruction(call, &ica)?;
        // The runtime resolves accounts by pubkey and applies the instruction's
        // authenticated order and privileges, regardless of this slice's order.
        invoke_signed(&instruction, accounts, &[seeds])?;
    }
    msg!("Executed ICA calls for {}", ica);
    Ok(())
}

/// Accounts: config, owner (signer), mailbox, followed by the seven mailbox
/// dispatch accounts. There is no remote-router allowlist, matching EVM overrides.
fn call_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    call: CallRemoteWithOverrides,
) -> ProgramResult {
    let [config, owner, mailbox, outbox, dispatch_authority, system, noop, payer, unique, dispatched] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let config = RouterConfig::load(program_id, config)?;
    if call.router == H256::zero() {
        return Err(ProgramError::InvalidArgument);
    }
    if !owner.is_signer || !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if mailbox.key != &config.mailbox || !mailbox.executable {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (authority, bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority.key != &authority {
        return Err(ProgramError::InvalidArgument);
    }
    let message = InterchainAccountMessage {
        owner: owner.key.to_bytes().into(),
        ism: call.ism,
        salt: call.salt,
        calls: call.calls,
    };
    let data = MailboxInstruction::OutboxDispatch(OutboxDispatch {
        sender: *program_id,
        destination_domain: call.destination,
        recipient: call.router,
        message_body: message.encode(),
    })
    .into_instruction_data()?;
    let metas = vec![
        AccountMeta::new(*outbox.key, false),
        AccountMeta::new_readonly(*dispatch_authority.key, true),
        AccountMeta::new_readonly(*system.key, false),
        AccountMeta::new_readonly(*noop.key, false),
        AccountMeta::new(*payer.key, true),
        AccountMeta::new_readonly(*unique.key, true),
        AccountMeta::new(*dispatched.key, false),
    ];
    // Forward the caller's unique signer. The mailbox verifies its signature
    // and message-storage PDA, matching Hyp token dispatch.
    invoke_signed(
        &Instruction {
            program_id: config.mailbox,
            accounts: metas,
            data,
        },
        &accounts[3..],
        &[mailbox_message_dispatch_authority_pda_seeds!(bump)],
    )?;
    // Preserve the mailbox's message-ID return data.
    msg!(
        "Dispatched ICA calls to {} for {}",
        call.destination,
        owner.key
    );
    Ok(())
}
