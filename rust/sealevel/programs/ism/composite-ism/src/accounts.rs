use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H160, H256, U256};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

/// Seed prefix for per-domain PDA accounts under a `Routing` node.
/// Full seeds: `[DOMAIN_ISM_SEED, &domain.to_le_bytes()]`.
pub const DOMAIN_ISM_SEED: &[u8] = b"domain_ism";

/// A node in the ISM config tree. Stored inline in the VAM PDA.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Clone)]
pub enum IsmNode {
    /// Verifies the message was submitted by the trusted relayer (signer check).
    /// ModuleType: Null.
    TrustedRelayer { relayer: Pubkey },

    /// ECDSA threshold multisig over CheckpointWithMessageId.
    /// Validators and threshold are stored inline; domain routing is handled
    /// externally by a `Routing` node.
    /// ModuleType: MessageIdMultisig.
    MultisigMessageId {
        /// ECDSA secp256k1 validator addresses.
        validators: Vec<H160>,
        threshold: u8,
    },

    /// m-of-n aggregation: all sub-ISMs with provided metadata must verify,
    /// and at least `threshold` must have metadata provided.
    /// ModuleType: Aggregation.
    Aggregation {
        threshold: u8,
        sub_isms: Vec<IsmNode>,
    },

    /// Always accepts (accept=true) or always rejects (accept=false).
    /// Intended for testing. ModuleType: Unused.
    Test { accept: bool },

    /// Rejects all messages when paused. Emergency circuit breaker.
    /// ModuleType: Null.
    Pausable { paused: bool },

    /// Routes based on the token amount in the message body.
    ///
    /// Reads `body[32..64]` as a big-endian u256 amount (TokenMessage format).
    /// Routes to `upper` if `amount >= threshold`, else `lower`.
    /// ModuleType: Routing.
    AmountRouting {
        /// U256 threshold; routes to `upper` if amount >= threshold, else `lower`.
        threshold: U256,
        lower: Box<IsmNode>,
        upper: Box<IsmNode>,
    },

    /// Token-bucket rate-limited ISM.
    ///
    /// Reads amount from `body[56..64]` (last 8 bytes of the 32-byte BE u256 in
    /// TokenMessage format). Enforces a rolling 24-hour transfer limit.
    ///
    /// `filled_level` and `last_updated` are mutable state fields updated on every
    /// successful `Verify`. Both are normalized to `(max_capacity, 0)` on
    /// `Initialize`/`UpdateConfig` -- callers cannot set arbitrary initial state.
    ///
    /// Calling `UpdateConfig` resets the rate limit state.
    ///
    /// ModuleType: Null.
    RateLimited {
        /// Config: max tokens transferable per 24-hour rolling window.
        max_capacity: u64,
        /// Config: if `Some`, only messages to this recipient are accepted.
        recipient: Option<H256>,
        /// State: current remaining capacity. Normalized to `max_capacity` on init.
        filled_level: u64,
        /// State: unix timestamp of last deduction. Normalized to `0` on init.
        last_updated: i64,
    },

    /// Routes to a per-domain PDA account based on the message's origin domain.
    ///
    /// Each domain's ISM is stored in its own PDA account rather than inline.
    /// Only the single domain PDA for the incoming message's origin is loaded at
    /// verify time, so heap usage is O(1) and the number of supported domains is
    /// unlimited.
    ///
    /// Each domain PDA is at seeds `[DOMAIN_ISM_SEED, &domain.to_le_bytes()]`
    /// (see [`derive_domain_pda`]). At most one `Routing` node is allowed per ISM
    /// tree (enforced by `validate_config`), so no namespace field is needed.
    ///
    /// `RateLimited` inside a domain PDA requires the domain PDA to be marked writable
    /// in the transaction; `Verify` will reject the instruction if it is not.
    /// `TrustedRelayer` requires a two-pass `VerifyAccountMetas` call (see relayer docs).
    ///
    /// ModuleType: Routing.
    Routing {
        /// Fallback ISM used when no domain PDA exists for the message's origin.
        default_ism: Option<Box<IsmNode>>,
    },
}

/// Data stored in the VAM PDA account (VERIFY_ACCOUNT_METAS_PDA_SEEDS).
/// Contains the complete ISM config tree.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq)]
pub struct CompositeIsmStorage {
    pub bump_seed: u8,
    pub owner: Option<Pubkey>,
    pub root: Option<IsmNode>,
}

impl SizedData for CompositeIsmStorage {
    fn size(&self) -> usize {
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

impl AccessControl for CompositeIsmStorage {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

pub type CompositeIsmAccount = AccountData<CompositeIsmStorage>;

/// Data stored in a per-domain PDA account for `Routing` nodes.
///
/// Stored at `[DOMAIN_ISM_SEED, &domain.to_le_bytes()]`.
/// `ism: None` means the account is uninitialized.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
pub struct DomainIsmStorage {
    pub bump_seed: u8,
    /// Origin domain ID that owns this PDA.  Stored inline so the CLI can
    /// enumerate all domain PDAs via `get_program_accounts` and recover the
    /// domain ID without needing the original config file.
    pub domain: u32,
    pub ism: Option<IsmNode>,
}

impl SizedData for DomainIsmStorage {
    fn size(&self) -> usize {
        borsh::to_vec(self).map(|v| v.len()).unwrap_or(0)
    }
}

pub type DomainIsmAccount = AccountData<DomainIsmStorage>;

/// Derives the PDA key and bump seed for a domain ISM account.
pub fn derive_domain_pda(program_id: &Pubkey, domain: u32) -> (Pubkey, u8) {
    let domain_bytes = domain.to_le_bytes();
    Pubkey::find_program_address(&[DOMAIN_ISM_SEED, &domain_bytes], program_id)
}

/// Loads and validates a domain ISM account, returning the full storage.
///
/// Returns `None` if the account is not owned by this program. Returns the
/// boxed `DomainIsmStorage` (including `bump_seed` and `ism`) otherwise.
pub fn load_domain_ism_storage(
    program_id: &Pubkey,
    domain: u32,
    account: &AccountInfo,
) -> Result<Option<Box<DomainIsmStorage>>, ProgramError> {
    if account.owner != program_id {
        return Ok(None);
    }

    let storage = DomainIsmAccount::fetch_data(&mut &account.data.borrow()[..])?
        .ok_or(ProgramError::UninitializedAccount)?;

    let domain_bytes = domain.to_le_bytes();
    let expected_key = Pubkey::create_program_address(
        &[DOMAIN_ISM_SEED, &domain_bytes, &[storage.bump_seed]],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;
    if *account.key != expected_key {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(Some(storage))
}

/// Loads and validates a domain ISM account.
///
/// Returns the stored `IsmNode` if the account is initialized, or `None` if the
/// account is not owned by this program (i.e. no domain config has been set).
/// Returns an error if the account belongs to the program but fails PDA
/// verification or deserialization.
pub fn load_domain_ism(
    program_id: &Pubkey,
    domain: u32,
    account: &AccountInfo,
) -> Result<Option<IsmNode>, ProgramError> {
    if account.owner != program_id {
        return Ok(None);
    }

    let storage = DomainIsmAccount::fetch_data(&mut &account.data.borrow()[..])?
        .ok_or(ProgramError::UninitializedAccount)?;

    // Verify PDA derivation using the bump stored in the account.
    let domain_bytes = domain.to_le_bytes();
    let expected_key = Pubkey::create_program_address(
        &[DOMAIN_ISM_SEED, &domain_bytes, &[storage.bump_seed]],
        program_id,
    )
    .map_err(|_| ProgramError::InvalidSeeds)?;
    if *account.key != expected_key {
        return Err(ProgramError::InvalidAccountData);
    }

    Ok(storage.ism.clone())
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_ism_node_borsh_roundtrip() {
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::TrustedRelayer {
                    relayer: Pubkey::new_unique(),
                },
                IsmNode::MultisigMessageId {
                    validators: vec![H160::zero()],
                    threshold: 1,
                },
            ],
        };
        let encoded = borsh::to_vec(&node).unwrap();
        let decoded: IsmNode = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(node, decoded);
    }

    #[test]
    fn test_routing_borsh_roundtrip() {
        let node = IsmNode::Routing {
            default_ism: Some(Box::new(IsmNode::Test { accept: false })),
        };
        let encoded = borsh::to_vec(&node).unwrap();
        let decoded: IsmNode = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(node, decoded);
    }

    #[test]
    fn test_domain_ism_storage_borsh_roundtrip() {
        let storage = DomainIsmStorage {
            bump_seed: 254,
            domain: 1234,
            ism: Some(IsmNode::Test { accept: true }),
        };
        let encoded = borsh::to_vec(&storage).unwrap();
        let decoded: DomainIsmStorage = BorshDeserialize::try_from_slice(&encoded).unwrap();
        assert_eq!(storage, decoded);
    }
}
