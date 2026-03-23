use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use hyperlane_core::{Decode, HyperlaneMessage, ModuleType, U256};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{StorageAccount, StorageData},
    error::Error,
    instruction::{ConfigData, Instruction as RoutingInstruction},
};

const ISM_TYPE: ModuleType = ModuleType::Routing;

/// PDA seeds for the storage account.
#[macro_export]
macro_rules! storage_pda_seeds {
    () => {{
        &[b"amount_routing_ism", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[b"amount_routing_ism", b"-", b"storage", &[$bump_seed]]
    }};
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(ism_instruction) = InterchainSecurityModuleInstruction::decode(instruction_data) {
        return match ism_instruction {
            InterchainSecurityModuleInstruction::Type => {
                set_return_data(
                    &borsh::to_vec(&SimulationReturnData::new(ISM_TYPE as u32))
                        .map_err(|_| ProgramError::BorshIoError)?[..],
                );
                Ok(())
            }
            InterchainSecurityModuleInstruction::Verify(verify_data) => verify(
                program_id,
                accounts,
                verify_data.metadata,
                verify_data.message,
            ),
            InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_data) => {
                let account_metas = verify_account_metas(
                    program_id,
                    accounts,
                    verify_data.metadata,
                    verify_data.message,
                )?;
                let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
                    .map_err(|_| ProgramError::BorshIoError)?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    match RoutingInstruction::decode(instruction_data)? {
        RoutingInstruction::Initialize(config) => initialize(program_id, accounts, config),
        RoutingInstruction::SetConfig(config) => set_config(program_id, accounts, config),
        RoutingInstruction::GetOwner => get_owner(program_id, accounts),
        RoutingInstruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
}

/// Routes message verification to the appropriate sub-ISM based on token amount.
///
/// The metadata bytes are passed through directly to the selected sub-ISM.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
/// 1. `[executable]` The selected sub-ISM program (must match routing decision).
/// 2..N. The accounts required by the selected sub-ISM's verify instruction.
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata_bytes: Vec<u8>,
    message_bytes: Vec<u8>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    // Determine which ISM to use based on token amount.
    let selected_ism = select_ism(&storage, &message_bytes)?;

    // Account 1: Selected sub-ISM program.
    let sub_ism_info = next_account_info(accounts_iter)?;
    if sub_ism_info.key != &selected_ism {
        return Err(Error::WrongSubIsm.into());
    }

    // Remaining accounts: sub-ISM verify accounts.
    let mut sub_verify_infos: Vec<AccountInfo> = vec![];
    let mut sub_verify_metas: Vec<AccountMeta> = vec![];
    for acct in accounts_iter {
        sub_verify_metas.push(AccountMeta {
            pubkey: *acct.key,
            is_signer: acct.is_signer,
            is_writable: acct.is_writable,
        });
        sub_verify_infos.push(acct.clone());
    }

    // CPI into selected sub-ISM.
    let verify_ix = InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
        metadata: metadata_bytes,
        message: message_bytes,
    });
    let ix = Instruction::new_with_bytes(
        selected_ism,
        &verify_ix
            .encode()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
        sub_verify_metas,
    );
    invoke(&ix, &sub_verify_infos)?;

    Ok(())
}

/// Returns the accounts required by `Verify` for the message's token amount.
///
/// Calls the selected sub-ISM's `VerifyAccountMetas` to collect its accounts,
/// then prepends the AmountRoutingIsm storage PDA.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
/// 1. `[executable]` The selected sub-ISM program.
/// 2. `[]` The selected sub-ISM's VERIFY_ACCOUNT_METAS_PDA (passed through).
fn verify_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata_bytes: Vec<u8>,
    message_bytes: Vec<u8>,
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let selected_ism = select_ism(&storage, &message_bytes)?;

    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), program_id);

    // Account 1: Selected sub-ISM program.
    let sub_ism_info = next_account_info(accounts_iter)?;
    if sub_ism_info.key != &selected_ism {
        return Err(Error::WrongSubIsm.into());
    }

    // Remaining accounts: passed through to sub-ISM VerifyAccountMetas.
    let mut sub_vam_infos: Vec<AccountInfo> = vec![];
    let mut sub_vam_metas: Vec<AccountMeta> = vec![];
    for acct in accounts_iter {
        sub_vam_metas.push(AccountMeta {
            pubkey: *acct.key,
            is_signer: acct.is_signer,
            is_writable: acct.is_writable,
        });
        sub_vam_infos.push(acct.clone());
    }

    // CPI to sub-ISM VerifyAccountMetas to get its required accounts.
    let vam_ix = InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
        metadata: metadata_bytes,
        message: message_bytes,
    });
    let ix = Instruction::new_with_bytes(
        selected_ism,
        &vam_ix
            .encode()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
        sub_vam_metas,
    );
    invoke(&ix, &sub_vam_infos)?;

    // Read sub-ISM's returned account metas from return data.
    let (return_program, return_data) =
        solana_program::program::get_return_data().ok_or(ProgramError::InvalidAccountData)?;
    if return_program != selected_ism {
        return Err(ProgramError::InvalidAccountData);
    }
    let SimulationReturnData {
        return_data: sub_account_metas,
        ..
    } = borsh::from_slice::<SimulationReturnData<Vec<SerializableAccountMeta>>>(&return_data)
        .map_err(|_| ProgramError::BorshIoError)?;

    // Result: [AmountRoutingIsm PDA, selected sub-ISM program, sub-ISM accounts...]
    let mut result: Vec<SerializableAccountMeta> = vec![
        AccountMeta::new_readonly(storage_pda_key, false).into(),
        AccountMeta::new_readonly(selected_ism, false).into(),
    ];
    result.extend(sub_account_metas);

    Ok(result)
}

/// Determines which sub-ISM to use based on the token transfer amount.
fn select_ism(storage: &StorageData, message_bytes: &[u8]) -> Result<Pubkey, ProgramError> {
    let message = HyperlaneMessage::read_from(&mut std::io::Cursor::new(message_bytes))
        .map_err(|_| ProgramError::InvalidArgument)?;
    let token_message = TokenMessage::read_from(&mut std::io::Cursor::new(message.body))
        .map_err(|_| Error::InvalidTokenMessage)?;

    let amount: U256 = token_message.amount();
    let threshold: U256 = U256::from(storage.threshold);

    Ok(if amount >= threshold {
        storage.upper_ism
    } else {
        storage.lower_ism
    })
}

/// Initializes the program.
///
/// Accounts:
/// 0. `[signer]` The owner/payer.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], config: ConfigData) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let storage_pda_account = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump) =
        Pubkey::find_program_address(storage_pda_seeds!(), program_id);
    if *storage_pda_account.key != storage_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    if let Ok(Some(_)) = StorageAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..]) {
        return Err(Error::AlreadyInitialized.into());
    }

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(Error::AccountOutOfOrder.into());
    }

    let storage = StorageAccount::from(StorageData {
        bump_seed: storage_pda_bump,
        owner: Some(*owner_account.key),
        threshold: config.threshold,
        lower_ism: config.lower_ism,
        upper_ism: config.upper_ism,
    });
    let storage_size = storage.size();
    create_pda_account(
        owner_account,
        &Rent::get()?,
        storage_size,
        program_id,
        system_program_account,
        storage_pda_account,
        storage_pda_seeds!(storage_pda_bump),
    )?;
    storage.store(storage_pda_account, false)?;

    Ok(())
}

/// Sets the routing config. Owner only.
///
/// Accounts:
/// 0. `[signer]` The owner.
/// 1. `[writable]` The storage PDA account.
fn set_config(program_id: &Pubkey, accounts: &[AccountInfo], config: ConfigData) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    storage.threshold = config.threshold;
    storage.lower_ism = config.lower_ism;
    storage.upper_ism = config.upper_ism;

    StorageAccount::from(*storage).store(storage_pda_account, false)?;

    Ok(())
}

/// Gets the owner. Returns as return data.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
fn get_owner(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_pda_account = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_pda_account)?;

    let bytes = borsh::to_vec(&SimulationReturnData::new(storage.owner))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Transfers ownership.
///
/// Accounts:
/// 0. `[signer]` The current owner.
/// 1. `[writable]` The storage PDA account.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.transfer_ownership(owner_account, new_owner)?;
    StorageAccount::from(*storage).store(storage_pda_account, false)?;

    Ok(())
}

/// Loads and validates the storage PDA account.
fn load_storage(
    program_id: &Pubkey,
    storage_pda_account: &AccountInfo,
) -> Result<Box<StorageData>, ProgramError> {
    if storage_pda_account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }
    let storage = StorageAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..])?
        .ok_or(Error::AccountNotInitialized)?;

    let storage_pda_key =
        Pubkey::create_program_address(storage_pda_seeds!(storage.bump_seed), program_id)?;
    if *storage_pda_account.key != storage_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    Ok(storage)
}

#[cfg(test)]
mod test {
    use super::*;
    use hyperlane_core::{Encode, HyperlaneMessage, H256};
    use hyperlane_warp_route::TokenMessage;

    fn make_message_with_amount(amount: u64) -> Vec<u8> {
        let token_message = TokenMessage::new(H256::zero(), U256::from(amount), vec![]);
        let body = token_message.to_vec();
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1,
            sender: H256::zero(),
            destination: 2,
            recipient: H256::zero(),
            body,
        };
        message.to_vec()
    }

    #[test]
    fn test_select_ism_lower() {
        let lower = Pubkey::new_unique();
        let upper = Pubkey::new_unique();
        let threshold = 1_000_000_000u64; // 1000 USDC

        let storage = StorageData {
            bump_seed: 0,
            owner: None,
            threshold,
            lower_ism: lower,
            upper_ism: upper,
        };

        // Amount below threshold → lower ISM.
        let message = make_message_with_amount(999_999_999);
        let selected = select_ism(&storage, &message).unwrap();
        assert_eq!(selected, lower);
    }

    #[test]
    fn test_select_ism_upper() {
        let lower = Pubkey::new_unique();
        let upper = Pubkey::new_unique();
        let threshold = 1_000_000_000u64;

        let storage = StorageData {
            bump_seed: 0,
            owner: None,
            threshold,
            lower_ism: lower,
            upper_ism: upper,
        };

        // Amount equal to threshold → upper ISM.
        let message = make_message_with_amount(1_000_000_000);
        let selected = select_ism(&storage, &message).unwrap();
        assert_eq!(selected, upper);

        // Amount above threshold → upper ISM.
        let message = make_message_with_amount(2_000_000_000);
        let selected = select_ism(&storage, &message).unwrap();
        assert_eq!(selected, upper);
    }
}
