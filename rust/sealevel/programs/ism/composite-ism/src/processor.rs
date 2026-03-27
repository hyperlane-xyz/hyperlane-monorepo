use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use hyperlane_core::{Decode, HyperlaneMessage, ModuleType};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    account_metas::all_verify_account_metas,
    accounts::{CompositeIsmAccount, CompositeIsmStorage, IsmNode},
    error::Error,
    instruction::Instruction,
    storage_pda_seeds,
    verify::verify_node,
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(ism_instruction) = InterchainSecurityModuleInstruction::decode(instruction_data) {
        return match ism_instruction {
            InterchainSecurityModuleInstruction::Type => ism_type(program_id, accounts),
            InterchainSecurityModuleInstruction::Verify(data) => {
                let message = HyperlaneMessage::read_from(&mut &data.message[..])
                    .map_err(|_| ProgramError::InvalidArgument)?;
                verify(program_id, accounts, &data.metadata, &message)
            }
            InterchainSecurityModuleInstruction::VerifyAccountMetas(data) => {
                let message = HyperlaneMessage::read_from(&mut &data.message[..])
                    .map_err(|_| ProgramError::InvalidArgument)?;
                let account_metas =
                    verify_account_metas(program_id, accounts, &data.metadata, &message)?;
                let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
                    .map_err(|_| ProgramError::BorshIoError)?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    match Instruction::decode(instruction_data)? {
        Instruction::Initialize(root) => initialize(program_id, accounts, root),
        Instruction::UpdateConfig(root) => update_config(program_id, accounts, root),
        Instruction::GetOwner => get_owner(program_id, accounts),
        Instruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
}

/// Returns the module type corresponding to the root ISM node.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
fn ism_type(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let module_type = match storage.root {
        Some(IsmNode::TrustedRelayer { .. }) => ModuleType::Null,
        Some(IsmNode::MultisigMessageId { .. }) => ModuleType::MessageIdMultisig,
        Some(IsmNode::Aggregation { .. }) => ModuleType::Aggregation,
        Some(IsmNode::Routing { .. }) => ModuleType::Routing,
        Some(IsmNode::Test { .. }) => ModuleType::Unused,
        Some(IsmNode::Pausable { .. }) => ModuleType::Null,
        Some(IsmNode::AmountRouting { .. }) => ModuleType::Routing,
        None => return Err(Error::ConfigNotSet.into()),
    };

    let bytes = borsh::to_vec(&SimulationReturnData::new(module_type as u32))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Verifies a message against the ISM config tree.
///
/// Accounts:
/// 0. `[]` The storage PDA account (VAM PDA).
/// 1..N. Additional accounts as returned by `VerifyAccountMetas` (e.g., relayer signer).
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let root = storage.root.as_ref().ok_or(Error::ConfigNotSet)?;
    verify_node(root, metadata, message, accounts_iter)
}

/// Returns the account metas required for `Verify`.
///
/// Accounts:
/// 0. `[]` The storage PDA account (VAM PDA).
fn verify_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> Result<Vec<serializable_account_meta::SerializableAccountMeta>, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let root = storage.root.as_ref().ok_or(Error::ConfigNotSet)?;

    let (vam_pda_key, _) = Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, program_id);

    Ok(all_verify_account_metas(
        &vam_pda_key,
        root,
        metadata,
        message,
    ))
}

/// Initializes the program, creating the storage PDA.
///
/// Accounts:
/// 0. `[signer]` The new owner and payer.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], root: IsmNode) -> ProgramResult {
    validate_config(&root)?;

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

    if let Ok(Some(_)) =
        CompositeIsmAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..])
    {
        return Err(Error::AlreadyInitialized.into());
    }

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(Error::AccountOutOfOrder.into());
    }

    let storage = CompositeIsmAccount::from(CompositeIsmStorage {
        bump_seed: storage_pda_bump,
        owner: Some(*owner_account.key),
        root: Some(root),
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

/// Replaces the full ISM config tree. Owner-gated. Reallocs PDA if needed.
///
/// Accounts:
/// 0. `[signer]` The owner.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program (required for realloc).
fn update_config(program_id: &Pubkey, accounts: &[AccountInfo], root: IsmNode) -> ProgramResult {
    validate_config(&root)?;

    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;
    storage.root = Some(root);

    CompositeIsmAccount::from(*storage).store(storage_pda_account, true)?;

    Ok(())
}

/// Gets the owner from the storage PDA, returning it as return data.
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
    CompositeIsmAccount::from(*storage).store(storage_pda_account, false)?;

    Ok(())
}

/// Validates the ISM config tree.
/// Returns an error if any Aggregation node has threshold > sub-ISM count,
/// or any MultisigMessageId domain config has threshold > validator count.
fn validate_config(node: &IsmNode) -> ProgramResult {
    match node {
        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            if *threshold as usize > sub_isms.len() || *threshold == 0 {
                return Err(Error::InvalidConfig.into());
            }
            for sub in sub_isms {
                validate_config(sub)?;
            }
            Ok(())
        }
        IsmNode::MultisigMessageId { domain_configs } => {
            for dc in domain_configs {
                if dc.threshold == 0 || dc.threshold as usize > dc.validators.len() {
                    return Err(Error::InvalidConfig.into());
                }
            }
            Ok(())
        }
        IsmNode::Routing {
            routes,
            default_ism,
        } => {
            for (_, sub) in routes {
                validate_config(sub)?;
            }
            if let Some(d) = default_ism {
                validate_config(d)?;
            }
            Ok(())
        }
        IsmNode::AmountRouting { lower, upper, .. } => {
            validate_config(lower)?;
            validate_config(upper)
        }
        // Leaf nodes with no sub-config to validate.
        IsmNode::TrustedRelayer { .. } | IsmNode::Test { .. } | IsmNode::Pausable { .. } => Ok(()),
    }
}

fn load_storage(
    program_id: &Pubkey,
    storage_pda_account: &AccountInfo,
) -> Result<Box<CompositeIsmStorage>, ProgramError> {
    if storage_pda_account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }

    let storage = CompositeIsmAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..])?
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
    use crate::accounts::DomainConfig;
    use account_utils::DiscriminatorEncode;
    use ecdsa_signature::EcdsaSignature;
    use hyperlane_core::{Encode, H160, H256};
    use hyperlane_sealevel_interchain_security_module_interface::{
        InterchainSecurityModuleInstruction, VerifyInstruction,
    };
    use multisig_ism::test_data::{get_multisig_ism_test_data, MultisigIsmTestData};
    use solana_program::pubkey::Pubkey;

    fn program_id() -> Pubkey {
        Pubkey::new_unique()
    }

    /// Creates a storage PDA key + bump, and writes the storage into a pre-allocated Vec.
    fn make_storage_pda(program_id: &Pubkey, root: Option<IsmNode>) -> (Pubkey, u8, Vec<u8>) {
        let (key, bump) = Pubkey::find_program_address(storage_pda_seeds!(), program_id);
        let storage = CompositeIsmStorage {
            bump_seed: bump,
            owner: Some(Pubkey::new_unique()),
            root,
        };
        // Allocate generously; store() will write into it.
        let mut data = vec![0u8; 4096];
        let mut lamports = 0u64;
        let acc = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut data,
            program_id,
            false,
        );
        CompositeIsmAccount::from(storage)
            .store(&acc, false)
            .unwrap();
        (key, bump, data)
    }

    fn account_info_from_data<'a>(
        key: &'a Pubkey,
        owner: &'a Pubkey,
        data: &'a mut Vec<u8>,
        lamports: &'a mut u64,
    ) -> AccountInfo<'a> {
        AccountInfo::new(key, false, true, lamports, data, owner, false)
    }

    #[test]
    fn test_ism_type_routing() {
        let id = program_id();
        let root = IsmNode::Routing {
            routes: vec![],
            default_ism: None,
        };
        let (key, _, mut data) = make_storage_pda(&id, Some(root));
        let mut lamports = 0u64;
        let acc = account_info_from_data(&key, &id, &mut data, &mut lamports);
        process_instruction(
            &id,
            &[acc],
            &InterchainSecurityModuleInstruction::Type.encode().unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn test_verify_test_accept() {
        let id = program_id();
        let root = IsmNode::Test { accept: true };
        let (key, _, mut data) = make_storage_pda(&id, Some(root));
        let mut lamports = 0u64;
        let acc = account_info_from_data(&key, &id, &mut data, &mut lamports);

        let msg = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1,
            sender: H256::zero(),
            destination: 2,
            recipient: H256::zero(),
            body: vec![],
        };

        let result = process_instruction(
            &id,
            &[acc],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: msg.to_vec(),
            })
            .encode()
            .unwrap(),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_test_reject() {
        let id = program_id();
        let root = IsmNode::Test { accept: false };
        let (key, _, mut data) = make_storage_pda(&id, Some(root));
        let mut lamports = 0u64;
        let acc = account_info_from_data(&key, &id, &mut data, &mut lamports);

        let msg = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1,
            sender: H256::zero(),
            destination: 2,
            recipient: H256::zero(),
            body: vec![],
        };

        let result = process_instruction(
            &id,
            &[acc],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: msg.to_vec(),
            })
            .encode()
            .unwrap(),
        );
        assert_eq!(result, Err(Error::VerifyRejected.into()));
    }

    #[test]
    fn test_validate_config_aggregation_threshold_too_high() {
        let node = IsmNode::Aggregation {
            threshold: 3,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_validate_config_aggregation_threshold_zero() {
        let node = IsmNode::Aggregation {
            threshold: 0,
            sub_isms: vec![IsmNode::Test { accept: true }],
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_validate_config_multisig_threshold_zero() {
        let node = IsmNode::MultisigMessageId {
            domain_configs: vec![DomainConfig {
                origin: 1,
                validators: vec![H160::random()],
                threshold: 0,
            }],
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_verify_multisig_message_id() {
        let MultisigIsmTestData {
            message,
            checkpoint,
            validators,
            signatures,
        } = get_multisig_ism_test_data();

        let id = program_id();
        let root = IsmNode::MultisigMessageId {
            domain_configs: vec![DomainConfig {
                origin: message.origin,
                validators,
                threshold: 2,
            }],
        };
        let (key, _, mut data) = make_storage_pda(&id, Some(root));
        let mut lamports = 0u64;
        let acc = account_info_from_data(&key, &id, &mut data, &mut lamports);

        let meta = crate::multisig_metadata::MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
            merkle_root: checkpoint.root,
            merkle_index: checkpoint.index,
            validator_signatures: vec![
                EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
            ],
        };

        let result = process_instruction(
            &id,
            &[acc],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: meta.to_vec(),
                message: message.to_vec(),
            })
            .encode()
            .unwrap(),
        );
        assert!(result.is_ok());
    }
}
