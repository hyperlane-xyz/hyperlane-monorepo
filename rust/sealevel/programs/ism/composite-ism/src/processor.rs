use std::collections::HashSet;

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
    account_metas::{all_verify_account_metas, contains_rate_limited},
    accounts::{
        derive_domain_pda, CompositeIsmAccount, CompositeIsmStorage, DomainIsmAccount,
        DomainIsmStorage, IsmNode, DOMAIN_ISM_SEED,
    },
    error::Error,
    instruction::Instruction,
    metadata_spec::{spec_for_node_with_pdas, MetadataSpec},
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
        Instruction::GetMetadataSpec(message_bytes) => {
            let message = HyperlaneMessage::read_from(&mut &message_bytes[..])
                .map_err(|_| ProgramError::InvalidArgument)?;
            let spec = get_metadata_spec(program_id, accounts, &message)?;
            let bytes = borsh::to_vec(&SimulationReturnData::new(spec))
                .map_err(|_| ProgramError::BorshIoError)?;
            set_return_data(&bytes[..]);
            Ok(())
        }
        Instruction::SetDomainIsm { domain, ism } => {
            set_domain_ism(program_id, accounts, domain, ism)
        }
        Instruction::RemoveDomainIsm { domain } => remove_domain_ism(program_id, accounts, domain),
    }
}

fn ism_type(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let _storage = load_storage(program_id, storage_info)?;

    let bytes = borsh::to_vec(&SimulationReturnData::new(ModuleType::Composite as u32))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Verifies a message against the ISM config tree.
///
/// Accounts:
/// 0. `[]` The storage PDA (writable when the tree contains `RateLimited`).
/// 1..N. Additional accounts as returned by `VerifyAccountMetas`.
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let mut storage = load_storage(program_id, storage_info)?;

    let needs_writeback = contains_rate_limited(storage.root.as_ref().ok_or(Error::ConfigNotSet)?);

    let root = storage.root.as_mut().ok_or(Error::ConfigNotSet)?;
    verify_node(root, metadata, message, accounts_iter, program_id)?;

    if needs_writeback {
        CompositeIsmAccount::from(storage).store(storage_info, true)?;
    }
    Ok(())
}

/// Returns the account metas required for `Verify`.
///
/// Accounts:
/// 0. `[]` The storage PDA.
/// 1..N. Domain PDAs for `Routing` nodes (passed in depth-first order for
///        two-pass resolution — see module-level docs).
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

    // Remaining accounts (after the VAM PDA) are potential domain PDAs for pass-2 resolution.
    let extra: Vec<&AccountInfo> = accounts_iter.collect();

    Ok(all_verify_account_metas(
        &vam_pda_key,
        root,
        metadata,
        message,
        program_id,
        &extra,
    ))
}

/// Returns the [`MetadataSpec`] for a given message.
///
/// Accounts:
/// 0. `[]` The storage PDA.
/// 1..N. Domain PDAs for any `Routing` nodes (depth-first order).
fn get_metadata_spec(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    message: &HyperlaneMessage,
) -> Result<MetadataSpec, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let root = storage.root.as_ref().ok_or(Error::ConfigNotSet)?;

    // Remaining accounts are domain PDAs consumed in depth-first order.
    let extra: Vec<&AccountInfo> = accounts_iter.collect();
    let mut extra_iter = extra.into_iter();

    spec_for_node_with_pdas(root, message, program_id, &mut extra_iter).map_err(Into::into)
}

/// Initializes the program, creating the storage PDA.
///
/// Accounts:
/// 0. `[signer]` The new owner and payer.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], mut root: IsmNode) -> ProgramResult {
    validate_config(&root)?;
    normalize_node(&mut root);

    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let storage_pda_account = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump) =
        Pubkey::find_program_address(storage_pda_seeds!(), program_id);
    if *storage_pda_account.key != storage_pda_key {
        return Err(Error::InvalidStoragePda.into());
    }

    if let Ok(Some(_)) =
        CompositeIsmAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..])
    {
        return Err(Error::AlreadyInitialized.into());
    }

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(Error::InvalidSystemProgram.into());
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

/// Replaces the full ISM config tree. Owner-gated.
///
/// Accounts:
/// 0. `[signer]` The owner.
/// 1. `[writable]` The storage PDA account.
fn update_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    mut root: IsmNode,
) -> ProgramResult {
    validate_config(&root)?;
    normalize_node(&mut root);

    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;
    storage.root = Some(root);

    CompositeIsmAccount::from(*storage).store(storage_pda_account, true)?;

    Ok(())
}

/// Creates or updates the ISM for a specific origin domain in a `Routing` table.
///
/// Accounts:
/// 0. `[signer]`     The owner.
/// 1. `[]`           The VAM storage PDA (ownership check).
/// 2. `[writable]`   The domain PDA.
/// 3. `[executable]` The system program.
fn set_domain_ism(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
    mut ism: IsmNode,
) -> ProgramResult {
    validate_domain_ism(&ism)?;
    normalize_node(&mut ism);

    let accounts_iter = &mut accounts.iter();
    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;
    let domain_pda_account = next_account_info(accounts_iter)?;
    let system_program_account = next_account_info(accounts_iter)?;

    // Verify owner via VAM PDA.
    let storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    // Derive and verify the domain PDA address.
    let domain_bytes = domain.to_le_bytes();
    let (expected_pda, bump) =
        Pubkey::find_program_address(&[DOMAIN_ISM_SEED, &domain_bytes], program_id);
    if *domain_pda_account.key != expected_pda {
        return Err(Error::InvalidDomainPda.into());
    }

    if system_program_account.key != &system_program::ID {
        return Err(Error::InvalidSystemProgram.into());
    }

    let domain_storage = DomainIsmAccount::from(DomainIsmStorage {
        bump_seed: bump,
        domain,
        ism: Some(ism),
    });
    let required_size = domain_storage.size();

    if domain_pda_account.data_is_empty() {
        // Account does not exist — create it.
        create_pda_account(
            owner_account,
            &Rent::get()?,
            required_size,
            program_id,
            system_program_account,
            domain_pda_account,
            &[DOMAIN_ISM_SEED, &domain_bytes, &[bump]],
        )?;
        domain_storage.store(domain_pda_account, false)?;
    } else {
        // Account exists — update it (realloc if needed).
        domain_storage.store_with_rent_exempt_realloc(
            domain_pda_account,
            &Rent::get()?,
            owner_account,
            system_program_account,
        )?;
    }

    Ok(())
}

/// Closes a domain PDA, returning rent to the owner.
///
/// Accounts:
/// 0. `[signer, writable]` The owner (receives the domain PDA's rent).
/// 1. `[]`         The VAM storage PDA (ownership check).
/// 2. `[writable]` The domain PDA.
fn remove_domain_ism(program_id: &Pubkey, accounts: &[AccountInfo], domain: u32) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;
    let domain_pda_account = next_account_info(accounts_iter)?;

    // Verify owner.
    let storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    // Verify domain PDA address.
    let (expected_pda, _) = derive_domain_pda(program_id, domain);
    if *domain_pda_account.key != expected_pda {
        return Err(Error::InvalidDomainPda.into());
    }

    if domain_pda_account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }

    // Transfer all lamports to owner, then zero out the account.
    let lamports = domain_pda_account.lamports();
    **domain_pda_account.try_borrow_mut_lamports()? = 0;
    **owner_account.try_borrow_mut_lamports()? += lamports;

    // Clear data and reassign to system program so the account is fully closed.
    domain_pda_account.assign(&system_program::ID);
    domain_pda_account.resize(0)?;

    Ok(())
}

fn get_owner(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_pda_account = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_pda_account)?;

    let bytes = borsh::to_vec(&SimulationReturnData::new(storage.owner))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);
    Ok(())
}

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

/// Validates the ISM config tree for the VAM PDA root.
///
/// Checks:
/// - Aggregation threshold in range.
/// - MultisigMessageId threshold in range.
/// - RateLimited max_capacity > 0.
/// - At most one Routing node in the tree.
fn validate_config(node: &IsmNode) -> ProgramResult {
    let mut routing_found = false;
    validate_config_inner(node, &mut routing_found)
}

fn validate_config_inner(node: &IsmNode, routing_found: &mut bool) -> ProgramResult {
    match node {
        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            if *threshold as usize > sub_isms.len() || *threshold == 0 {
                return Err(Error::InvalidConfig.into());
            }
            for sub in sub_isms {
                validate_config_inner(sub, routing_found)?;
            }
            Ok(())
        }
        IsmNode::MultisigMessageId {
            validators,
            threshold,
        } => {
            if *threshold == 0 || *threshold as usize > validators.len() {
                return Err(Error::InvalidConfig.into());
            }
            // Reject duplicate validators: with [A, A, B] and threshold 2, the
            // ascending-index scan in verify_node would accept two sigs from A as
            // quorum, collapsing "2-of-3" into "1-of-2 unique". Matches the check
            // in the standalone multisig-ism-message-id program.
            let mut seen = HashSet::with_capacity(validators.len());
            for v in validators {
                if !seen.insert(v) {
                    return Err(Error::InvalidConfig.into());
                }
            }
            Ok(())
        }
        IsmNode::AmountRouting { lower, upper, .. } => {
            validate_config_inner(lower, routing_found)?;
            validate_config_inner(upper, routing_found)
        }
        IsmNode::RateLimited { max_capacity, .. } => {
            if *max_capacity == 0 {
                return Err(Error::InvalidConfig.into());
            }
            Ok(())
        }
        IsmNode::Routing { default_ism } => {
            if *routing_found {
                return Err(Error::MultipleRoutingNodes.into());
            }
            *routing_found = true;
            if let Some(d) = default_ism {
                validate_config_inner(d, routing_found)?;
            }
            Ok(())
        }
        IsmNode::TrustedRelayer { .. } | IsmNode::Test { .. } | IsmNode::Pausable { .. } => Ok(()),
    }
}

/// Validates an ISM intended for storage in a domain PDA.
///
/// Disallows `Routing` (nested routing is not supported).
fn validate_domain_ism(node: &IsmNode) -> ProgramResult {
    match node {
        IsmNode::RateLimited { max_capacity, .. } => {
            if *max_capacity == 0 {
                return Err(Error::InvalidConfig.into());
            }
            Ok(())
        }
        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            if *threshold as usize > sub_isms.len() || *threshold == 0 {
                return Err(Error::InvalidConfig.into());
            }
            for sub in sub_isms {
                validate_domain_ism(sub)?;
            }
            Ok(())
        }
        IsmNode::MultisigMessageId {
            validators,
            threshold,
        } => {
            if *threshold == 0 || *threshold as usize > validators.len() {
                return Err(Error::InvalidConfig.into());
            }
            let mut seen = HashSet::with_capacity(validators.len());
            for v in validators {
                if !seen.insert(v) {
                    return Err(Error::InvalidConfig.into());
                }
            }
            Ok(())
        }
        IsmNode::AmountRouting { lower, upper, .. } => {
            validate_domain_ism(lower)?;
            validate_domain_ism(upper)
        }
        IsmNode::Routing { .. } => Err(Error::RoutingInDomainIsm.into()),
        IsmNode::TrustedRelayer { .. } | IsmNode::Test { .. } | IsmNode::Pausable { .. } => Ok(()),
    }
}

/// Normalizes mutable state fields in `RateLimited` nodes to their canonical
/// initial values, recursively.
fn normalize_node(node: &mut IsmNode) {
    match node {
        IsmNode::RateLimited {
            max_capacity,
            filled_level,
            last_updated,
            ..
        } => {
            *filled_level = *max_capacity;
            *last_updated = 0;
        }
        IsmNode::Aggregation { sub_isms, .. } => {
            sub_isms.iter_mut().for_each(normalize_node);
        }
        IsmNode::AmountRouting { lower, upper, .. } => {
            normalize_node(lower);
            normalize_node(upper);
        }
        IsmNode::Routing {
            default_ism: Some(d),
            ..
        } => {
            normalize_node(d);
        }
        IsmNode::Routing { .. } => {}
        _ => {}
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
        return Err(Error::InvalidStoragePda.into());
    }

    Ok(storage)
}

#[cfg(test)]
mod test {
    use super::*;
    use ecdsa_signature::EcdsaSignature;
    use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Encode, H160, H256};
    use hyperlane_sealevel_interchain_security_module_interface::{
        InterchainSecurityModuleInstruction, VerifyInstruction,
    };
    use solana_program::pubkey::Pubkey;
    use std::str::FromStr;

    fn program_id() -> Pubkey {
        Pubkey::new_unique()
    }

    fn make_storage_pda(program_id: &Pubkey, root: Option<IsmNode>) -> (Pubkey, u8, Vec<u8>) {
        let (key, bump) = Pubkey::find_program_address(storage_pda_seeds!(), program_id);
        let storage = CompositeIsmStorage {
            bump_seed: bump,
            owner: Some(Pubkey::new_unique()),
            root,
        };
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
            validators: vec![H160::random()],
            threshold: 0,
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_validate_config_multisig_duplicate_validators_rejected() {
        let v = H160::random();
        let node = IsmNode::MultisigMessageId {
            validators: vec![v, v],
            threshold: 2,
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_validate_config_multisig_unique_validators_ok() {
        let node = IsmNode::MultisigMessageId {
            validators: vec![H160::random(), H160::random()],
            threshold: 2,
        };
        assert!(validate_config(&node).is_ok());
    }

    #[test]
    fn test_validate_config_rate_limited_zero_capacity() {
        let node = IsmNode::RateLimited {
            max_capacity: 0,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_validate_config_multiple_routing_nodes() {
        let node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Routing { default_ism: None },
                IsmNode::Routing { default_ism: None },
            ],
        };
        assert_eq!(
            validate_config(&node).unwrap_err(),
            Error::MultipleRoutingNodes.into()
        );
    }

    #[test]
    fn test_validate_config_single_routing_node_ok() {
        let node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Routing { default_ism: None },
                IsmNode::Test { accept: true },
            ],
        };
        assert!(validate_config(&node).is_ok());
    }

    #[test]
    fn test_validate_domain_ism_rejects_routing() {
        let node = IsmNode::Routing { default_ism: None };
        assert_eq!(
            validate_domain_ism(&node).unwrap_err(),
            Error::RoutingInDomainIsm.into()
        );
    }

    #[test]
    fn test_validate_domain_ism_rejects_routing_nested_in_aggregation() {
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![IsmNode::Routing { default_ism: None }],
        };
        assert_eq!(
            validate_domain_ism(&node).unwrap_err(),
            Error::RoutingInDomainIsm.into()
        );
    }

    #[test]
    fn test_validate_domain_ism_rate_limited_ok() {
        let node = IsmNode::RateLimited {
            max_capacity: 100,
            recipient: None,
            filled_level: 100,
            last_updated: 0,
        };
        assert!(validate_domain_ism(&node).is_ok());
    }

    #[test]
    fn test_validate_domain_ism_rate_limited_zero_capacity() {
        let node = IsmNode::RateLimited {
            max_capacity: 0,
            recipient: None,
            filled_level: 0,
            last_updated: 0,
        };
        assert_eq!(
            validate_domain_ism(&node).unwrap_err(),
            Error::InvalidConfig.into()
        );
    }

    #[test]
    fn test_normalize_node_rate_limited() {
        let mut node = IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 0,
            last_updated: 999,
        };
        normalize_node(&mut node);
        assert_eq!(
            node,
            IsmNode::RateLimited {
                max_capacity: 1_000,
                recipient: None,
                filled_level: 1_000,
                last_updated: 0,
            }
        );
    }

    #[test]
    fn test_normalize_node_nested_in_aggregation() {
        let mut node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![IsmNode::RateLimited {
                max_capacity: 500,
                recipient: None,
                filled_level: 0,
                last_updated: 42,
            }],
        };
        normalize_node(&mut node);
        if let IsmNode::Aggregation { sub_isms, .. } = &node {
            assert_eq!(
                sub_isms[0],
                IsmNode::RateLimited {
                    max_capacity: 500,
                    recipient: None,
                    filled_level: 500,
                    last_updated: 0,
                }
            );
        }
    }

    #[test]
    fn test_verify_multisig_message_id() {
        let message = HyperlaneMessage {
            version: 3,
            nonce: 69,
            origin: 1234,
            sender: H256::from_str(
                "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
            )
            .unwrap(),
            destination: 4321,
            recipient: H256::from_str(
                "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
            )
            .unwrap(),
            body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        };
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: H256::from_str(
                    "0xabababababababababababababababababababababababababababababababab",
                )
                .unwrap(),
                mailbox_domain: 1234,
                root: H256::from_str(
                    "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                )
                .unwrap(),
                index: message.nonce + 1,
            },
            message_id: message.id(),
        };
        let validators = vec![
            H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
            H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
        ];
        let sig0 = hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap();
        let sig1 = hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap();

        let id = program_id();
        let root = IsmNode::MultisigMessageId {
            validators,
            threshold: 2,
        };
        let (key, _, mut data) = make_storage_pda(&id, Some(root));
        let mut lamports = 0u64;
        let acc = account_info_from_data(&key, &id, &mut data, &mut lamports);

        let meta = multisig_ism::MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
            merkle_root: checkpoint.checkpoint.root,
            merkle_index: checkpoint.checkpoint.index,
            validator_signatures: vec![
                EcdsaSignature::from_bytes(&sig0).unwrap(),
                EcdsaSignature::from_bytes(&sig1).unwrap(),
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
