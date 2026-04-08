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
    accounts::{CompositeIsmAccount, CompositeIsmStorage, IsmNode, PendingConfig},
    error::Error,
    instruction::Instruction,
    metadata_spec::{spec_for_node, MetadataSpec},
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
        Instruction::BeginConfigUpdate(total_len) => {
            begin_config_update(program_id, accounts, total_len)
        }
        Instruction::WriteConfigChunk { offset, data } => {
            write_config_chunk(program_id, accounts, offset, &data)
        }
        Instruction::CommitConfigUpdate => commit_config_update(program_id, accounts),
        Instruction::AbortConfigUpdate => abort_config_update(program_id, accounts),
    }
}

/// Returns the module type for this ISM.
///
/// Always returns `ModuleType::Composite` so the relayer knows to use the
/// `GetMetadataSpec` path rather than the per-ISM-type chain calls.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
fn ism_type(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    // Validate that the account is a properly initialised composite ISM PDA
    // (this also checks program ownership and PDA derivation).
    let _storage = load_storage(program_id, storage_info)?;

    let bytes = borsh::to_vec(&SimulationReturnData::new(ModuleType::Composite as u32))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Verifies a message against the ISM config tree.
///
/// Accounts:
/// 0. `[]` The storage PDA account (VAM PDA). Marked writable when the ISM tree
///    contains a `RateLimited` node (state must be written back after verify).
/// 1..N. Additional accounts as returned by `VerifyAccountMetas` (e.g., relayer signer).
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let mut storage = load_storage(program_id, storage_info)?;

    // Determine before taking &mut borrow whether we need to write back.
    let needs_writeback = contains_rate_limited(storage.root.as_ref().ok_or(Error::ConfigNotSet)?);

    let root = storage.root.as_mut().ok_or(Error::ConfigNotSet)?;
    verify_node(root, metadata, message, accounts_iter)?;

    if needs_writeback {
        CompositeIsmAccount::from(storage).store(storage_info, true)?;
    }
    Ok(())
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

/// Returns the [`MetadataSpec`] for a given message.
///
/// Resolves Routing/AmountRouting inline so the relayer receives a flat spec
/// without needing to know about routing nodes.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
fn get_metadata_spec(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    message: &HyperlaneMessage,
) -> Result<MetadataSpec, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let root = storage.root.as_ref().ok_or(Error::ConfigNotSet)?;
    spec_for_node(root, message).map_err(Into::into)
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
        pending_config: None,
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
/// Calling `UpdateConfig` with a `RateLimited` node resets the rate limit state
/// (`filled_level = max_capacity`, `last_updated = 0`).
///
/// Accounts:
/// 0. `[signer]` The owner.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program (required for realloc).
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
    let system_program_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;
    storage.root = Some(root);

    CompositeIsmAccount::from(*storage).store_with_rent_exempt_realloc(
        storage_pda_account,
        &Rent::get()?,
        owner_account,
        system_program_account,
    )?;

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

/// Allocates (or resets) the staging buffer for a multi-tx config update.
///
/// Accounts:
/// 0. `[signer]`     The owner.
/// 1. `[writable]`   The storage PDA account.
/// 2. `[executable]` The system program.
fn begin_config_update(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    total_len: u32,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;
    let system_program_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    storage.pending_config = Some(PendingConfig {
        total_len,
        bytes: vec![0u8; total_len as usize],
    });

    CompositeIsmAccount::from(*storage).store_with_rent_exempt_realloc(
        storage_pda_account,
        &Rent::get()?,
        owner_account,
        system_program_account,
    )?;
    Ok(())
}

/// Writes a byte slice into the staging buffer at the given offset.
///
/// Accounts:
/// 0. `[signer]`   The owner.
/// 1. `[writable]` The storage PDA account.
fn write_config_chunk(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    offset: u32,
    data: &[u8],
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    let pending = storage
        .pending_config
        .as_mut()
        .ok_or(Error::NoPendingUpdate)?;

    let end = (offset as usize)
        .checked_add(data.len())
        .ok_or(Error::ChunkOutOfBounds)?;
    if end > pending.total_len as usize {
        return Err(Error::ChunkOutOfBounds.into());
    }

    pending.bytes[offset as usize..end].copy_from_slice(data);

    // No realloc — space pre-allocated by BeginConfigUpdate.
    CompositeIsmAccount::from(*storage).store(storage_pda_account, false)?;
    Ok(())
}

/// Deserialises, validates and commits the staged bytes as the new `root`.
///
/// Accounts:
/// 0. `[signer]`     The owner.
/// 1. `[writable]`   The storage PDA account.
/// 2. `[executable]` The system program.
fn commit_config_update(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;
    let system_program_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    let pending = storage
        .pending_config
        .take()
        .ok_or(Error::NoPendingUpdate)?;

    let mut root: IsmNode = borsh::from_slice(&pending.bytes).map_err(|_| Error::InvalidConfig)?;
    validate_config(&root)?;
    normalize_node(&mut root);

    storage.root = Some(root);
    // pending_config is already None (taken above).

    // Realloc PDA — pending space freed, new root may be a different size.
    CompositeIsmAccount::from(*storage).store_with_rent_exempt_realloc(
        storage_pda_account,
        &Rent::get()?,
        owner_account,
        system_program_account,
    )?;
    Ok(())
}

/// Discards the staging buffer without committing (no-op if none exists).
///
/// Accounts:
/// 0. `[signer]`     The owner.
/// 1. `[writable]`   The storage PDA account.
/// 2. `[executable]` The system program.
fn abort_config_update(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    storage.pending_config = None;

    CompositeIsmAccount::from(*storage).store(storage_pda_account, true)?;
    Ok(())
}

/// Validates the ISM config tree.
/// Returns an error if any Aggregation node has threshold > sub-ISM count,
/// any MultisigMessageId domain config has threshold > validator count,
/// or any RateLimited node has max_capacity == 0.
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
        IsmNode::RateLimited { max_capacity, .. } => {
            if *max_capacity == 0 {
                return Err(Error::InvalidConfig.into());
            }
            Ok(())
        }
        // Leaf nodes with no sub-config to validate.
        IsmNode::TrustedRelayer { .. } | IsmNode::Test { .. } | IsmNode::Pausable { .. } => Ok(()),
    }
}

/// Normalizes mutable state fields in `RateLimited` nodes to their canonical
/// initial values, recursively. Called before storing any config to prevent
/// callers from supplying arbitrary state.
///
/// Sets `filled_level = max_capacity` and `last_updated = 0` for every
/// `RateLimited` node in the tree.
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
        IsmNode::Routing {
            routes,
            default_ism,
        } => {
            routes.iter_mut().for_each(|(_, n)| normalize_node(n));
            if let Some(d) = default_ism {
                normalize_node(d);
            }
        }
        IsmNode::AmountRouting { lower, upper, .. } => {
            normalize_node(lower);
            normalize_node(upper);
        }
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
        return Err(Error::AccountOutOfOrder.into());
    }

    Ok(storage)
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::accounts::DomainConfig;
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
            pending_config: None,
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
    fn test_normalize_node_rate_limited() {
        let mut node = IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 0,   // should become 1_000
            last_updated: 999, // should become 0
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
