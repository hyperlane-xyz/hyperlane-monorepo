//! InterchainAccount program.

use access_control::AccessControl;
use account_utils::{
    create_pda_account, verify_account_uninitialized, DiscriminatorDecode, SizedData,
};
use borsh::BorshSerialize;

use hyperlane_interchain_accounts::InterchainAccountMessage;
use hyperlane_sealevel_connection_client::{
    router::{HyperlaneRouterAccessControl, HyperlaneRouterDispatch, RemoteRouterConfig},
    // HyperlaneConnectionClient,
};
// use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_mailbox::mailbox_message_dispatch_authority_pda_seeds;
use hyperlane_sealevel_message_recipient_interface::MessageRecipientInstruction;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_program,
    sysvar::Sysvar,
};

use hyperlane_core::{Encode, H256};

use crate::{
    accounts::{InterchainAccountStorage, InterchainAccountStorageAccount},
    instruction::{CallRemoteMessage, Init, InterchainAccountInstruction},
};

/// Seeds relating to the PDA account with program data.
#[macro_export]
macro_rules! program_storage_pda_seeds {
    () => {{
        &[b"interchain_account", b"-", b"handle", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"interchain_account",
            b"-",
            b"handle",
            b"-",
            b"storage",
            &[$bump_seed],
        ]
    }};
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// The program's entrypoint.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(recipient_instruction) = MessageRecipientInstruction::decode(instruction_data) {
        return match recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                get_interchain_security_module(program_id, accounts)
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                set_ism_meta_return_data(program_id)
            }
            MessageRecipientInstruction::Handle(_instruction) => {
                unimplemented!("Handle instruction not implemented")
            }
            MessageRecipientInstruction::HandleAccountMetas(_) => {
                unimplemented!("HandleAccountMetas instruction not implemented")
            }
        };
    }

    let instruction = InterchainAccountInstruction::decode(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        InterchainAccountInstruction::Init(mailbox) => init(program_id, accounts, mailbox),
        InterchainAccountInstruction::CallRemote(remote_call) => {
            send_call_remote(program_id, accounts, remote_call)
        }
        InterchainAccountInstruction::SetInterchainSecurityModule(ism) => {
            set_interchain_security_module(program_id, accounts, ism)
        }
        InterchainAccountInstruction::EnrollRemoteRouters(configs) => {
            enroll_remote_routers(program_id, accounts, configs)
        }
        InterchainAccountInstruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
}

/// Creates the storage PDA.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[signer]` Payer.
/// 2. `[writeable]` Storage PDA.
fn init(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump_seed) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    verify_account_uninitialized(storage_info)?;

    let storage_account = InterchainAccountStorageAccount::from(InterchainAccountStorage {
        local_domain: init.local_domain,
        mailbox: init.mailbox,
        ism: init.ism,
        igp: init.igp,
        owner: init.owner,
        ..Default::default()
    });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        storage_account.size(),
        program_id,
        system_program_info,
        storage_info,
        program_storage_pda_seeds!(storage_pda_bump_seed),
    )?;
    // Store it
    storage_account.store(storage_info, false)?;

    Ok(())
}

/// Dispatches a message using the dispatch authority.
///
/// Accounts:
/// 0.  `[]` Program storage (read-only)
/// 1.  `[signer]` Call remote sender signer.
/// 2.  `[executable]` The Mailbox program.
/// 3.  `[writeable]` Outbox PDA.
/// 4.  `[]` This program's dispatch authority.
/// 5.  `[executable]` System program.
/// 6.  `[executable]` SPL Noop program.
/// 7.  `[signer]` Unique message account.
/// 8.  `[writeable]` Dispatched message PDA. An empty message PDA relating to the seeds
///    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
///    ---- if an IGP is configured ----
///  9.  `[executable]` The IGP program.
/// 10. `[writeable]` The IGP program data.
/// 11. `[writeable]` The gas payment PDA.
/// 12. `[]` OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
/// 13. `[writeable]` The IGP account.
///     ---- end if an IGP is configured ----
fn send_call_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    remote_call: CallRemoteMessage,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Program storage.
    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let storage =
        InterchainAccountStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 1: Payer & message sender signer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // Owner of the interchain‑account call is the signer's pubkey.
    let owner = H256(payer_info.key.to_bytes());

    // Account 2: Mailbox program.
    let _mailbox_info = next_account_info(accounts_iter)?;

    // Account 3: Outbox PDA.
    let mailbox_outbox_info = next_account_info(accounts_iter)?;

    // Account 4: Dispatch authority.
    let dispatch_authority_info = next_account_info(accounts_iter)?;
    let (expected_dispatch_authority_key, expected_dispatch_authority_bump) =
        Pubkey::find_program_address(mailbox_message_dispatch_authority_pda_seeds!(), program_id);
    if dispatch_authority_info.key != &expected_dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 5: System program.
    let system_program_info = next_account_info(accounts_iter)?;

    // Account 6: SPL Noop program.
    let spl_noop_info = next_account_info(accounts_iter)?;

    // Account 8: Unique message account.
    let unique_message_account_info = next_account_info(accounts_iter)?;

    // Account 9: Dispatched message PDA.
    let dispatched_message_info = next_account_info(accounts_iter)?;

    let dispatch_account_metas = vec![
        AccountMeta::new(*mailbox_outbox_info.key, false),
        AccountMeta::new_readonly(*dispatch_authority_info.key, true),
        AccountMeta::new_readonly(*system_program_info.key, false),
        AccountMeta::new_readonly(*spl_noop_info.key, false),
        AccountMeta::new(*payer_info.key, true), // signer & payer
        AccountMeta::new_readonly(*unique_message_account_info.key, true),
        AccountMeta::new(*dispatched_message_info.key, false),
    ];
    let dispatch_account_infos = &[
        mailbox_outbox_info.clone(),
        dispatch_authority_info.clone(),
        system_program_info.clone(),
        spl_noop_info.clone(),
        payer_info.clone(),
        unique_message_account_info.clone(),
        dispatched_message_info.clone(),
    ];

    // let igp_payment_accounts =
    //     if let Some((igp_program_id, igp_account_type)) = storage.interchain_gas_paymaster() {
    //         // Account 10: The IGP program
    //         let igp_program_account_info = next_account_info(accounts_iter)?;
    //         if igp_program_account_info.key != igp_program_id {
    //             return Err(ProgramError::InvalidArgument);
    //         }

    //         // Account 11: The IGP program data.
    //         // No verification is performed here, the IGP will do that.
    //         let igp_program_data_account_info = next_account_info(accounts_iter)?;

    //         // Account 12: The gas payment PDA.
    //         // No verification is performed here, the IGP will do that.
    //         let igp_payment_pda_account_info = next_account_info(accounts_iter)?;

    //         // Account 13: The configured IGP account.
    //         let configured_igp_account_info = next_account_info(accounts_iter)?;
    //         if configured_igp_account_info.key != igp_account_type.key() {
    //             return Err(ProgramError::InvalidArgument);
    //         }

    //         // Accounts expected by the IGP's `PayForGas` instruction:
    //         //
    //         // 0. `[executable]` The system program.
    //         // 1. `[signer]` The payer.
    //         // 2. `[writeable]` The IGP program data.
    //         // 3. `[signer]` Unique gas payment account.
    //         // 4. `[writeable]` Gas payment PDA.
    //         // 5. `[writeable]` The IGP account.
    //         // 6. `[]` Overhead IGP account (optional).

    //         let mut igp_payment_account_metas = vec![
    //             AccountMeta::new_readonly(solana_program::system_program::id(), false),
    //             AccountMeta::new(*payer_info.key, true),
    //             AccountMeta::new(*igp_program_data_account_info.key, false),
    //             AccountMeta::new_readonly(*unique_message_account_info.key, true),
    //             AccountMeta::new(*igp_payment_pda_account_info.key, false),
    //         ];
    //         let mut igp_payment_account_infos = vec![
    //             system_program_info.clone(),
    //             payer_info.clone(),
    //             igp_program_data_account_info.clone(),
    //             unique_message_account_info.clone(),
    //             igp_payment_pda_account_info.clone(),
    //         ];

    //         match igp_account_type {
    //             InterchainGasPaymasterType::Igp(_) => {
    //                 igp_payment_account_metas
    //                     .push(AccountMeta::new(*configured_igp_account_info.key, false));
    //                 igp_payment_account_infos.push(configured_igp_account_info.clone());
    //             }
    //             InterchainGasPaymasterType::OverheadIgp(_) => {
    //                 // Account 13: The inner IGP account.
    //                 let inner_igp_account_info = next_account_info(accounts_iter)?;

    //                 // The inner IGP is expected first, then the overhead IGP.
    //                 igp_payment_account_metas.extend([
    //                     AccountMeta::new(*inner_igp_account_info.key, false),
    //                     AccountMeta::new_readonly(*configured_igp_account_info.key, false),
    //                 ]);
    //                 igp_payment_account_infos.extend([
    //                     inner_igp_account_info.clone(),
    //                     configured_igp_account_info.clone(),
    //                 ]);
    //             }
    //         };

    //         Some((igp_payment_account_metas, igp_payment_account_infos))
    //     } else {
    //         None
    //     };

    let message =
        InterchainAccountMessage::new(owner, remote_call.ism, remote_call.salt, remote_call.calls);
    let mut encoded_message = vec![];
    message
        .write_to(&mut encoded_message)
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    let dispatch_authority_seeds: &[&[u8]] =
        mailbox_message_dispatch_authority_pda_seeds!(expected_dispatch_authority_bump);

    // if let Some((igp_payment_account_metas, igp_payment_account_infos)) = igp_payment_accounts {
    //     // Dispatch the message and pay for gas.
    //     storage.dispatch_with_gas(
    //         program_id,
    //         dispatch_authority_seeds,
    //         remote_call.destination,
    //         encoded_message.into(),
    //         remote_call.gas_limit,
    //         dispatch_account_metas,
    //         dispatch_account_infos,
    //         igp_payment_account_metas,
    //         &igp_payment_account_infos,
    //     )?;
    // } else {
    // Dispatch the message.
    storage.dispatch(
        program_id,
        dispatch_authority_seeds,
        remote_call.destination,
        encoded_message.into(),
        dispatch_account_metas,
        dispatch_account_infos,
    )?;
    // }

    msg!(
        "Remote call requested, owner: {}, destination: {}, ism: {:?}, salt: {:?}",
        owner,
        remote_call.destination,
        remote_call.ism,
        remote_call.salt
    );

    Ok(())
}

/// Accounts:
/// 0. `[writeable]` Storage PDA account.
/// 1. `[signer]` Owner.
fn set_interchain_security_module(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    // Not bothering with validity checks because this is a test program
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        InterchainAccountStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 1: Owner.
    let owner_info = next_account_info(accounts_iter)?;
    storage.ensure_owner_signer(owner_info)?;

    storage.ism = ism;

    // Store it
    InterchainAccountStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. `[writeable]` Storage PDA account.
/// 1. `[signer]` Current owner.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        InterchainAccountStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 1: Current owner signer.
    let owner_info = next_account_info(accounts_iter)?;
    storage.ensure_owner_signer(owner_info)?;

    // Update owner.
    storage.owner = new_owner;

    // Store it
    InterchainAccountStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. `[]` Storage PDA account.
fn get_interchain_security_module(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let storage =
        InterchainAccountStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    set_return_data(
        &storage
            .ism
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
    );

    Ok(())
}

fn set_ism_meta_return_data(program_id: &Pubkey) -> ProgramResult {
    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);

    let account_metas: Vec<SerializableAccountMeta> =
        vec![AccountMeta::new(storage_pda_key, false).into()];

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

/// Enrolls remote routers.
///
/// Accounts:
/// 0. `[executable]` System program.
/// 1. `[writeable]` Storage PDA account.
/// 2. `[signer]` Owner.
fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<RemoteRouterConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Storage PDA account.
    let storage_info = next_account_info(accounts_iter)?;
    let (expected_storage_pda_key, _expected_storage_pda_bump) =
        Pubkey::find_program_address(program_storage_pda_seeds!(), program_id);
    if storage_info.key != &expected_storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }
    let mut storage =
        InterchainAccountStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    // Account 2: Owner.
    let owner_info = next_account_info(accounts_iter)?;
    storage.enroll_remote_routers_only_owner(owner_info, configs)?;

    // Store it, & realloc if needed
    InterchainAccountStorageAccount::from(storage).store_with_rent_exempt_realloc(
        storage_info,
        &Rent::get()?,
        owner_info,
        system_program_info,
    )?;

    Ok(())
}
