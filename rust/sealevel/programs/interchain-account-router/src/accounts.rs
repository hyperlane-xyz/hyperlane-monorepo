//! Router configuration and deterministic interchain account authorities.

use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

/// Router configuration also serves as the standard ISM discovery PDA.
pub const CONFIG_SEEDS: &[&[u8]] = VERIFY_ACCOUNT_METAS_PDA_SEEDS;
/// Interchain account authority PDA seed prefix.
pub const ICA_SEED: &[u8] = b"ica";

/// Canonical ICA seeds, optionally including a signing bump.
#[macro_export]
macro_rules! interchain_account_seeds {
    ($origin:expr, $owner:expr, $router:expr, $ism:expr, $salt:expr $(, $bump:expr)?) => {
        &[
            $crate::accounts::ICA_SEED,
            &$origin.to_be_bytes(),
            $owner.as_bytes(),
            $router.as_bytes(),
            $ism.as_bytes(),
            $salt.as_bytes(),
            $(&[$bump],)?
        ]
    };
}

/// Immutable router configuration. The mailbox supplies the fallback ISM.
#[derive(BorshSerialize, BorshDeserialize, Default, Debug)]
pub struct RouterConfig {
    /// Mailbox authorized to deliver messages and used for outgoing messages.
    pub mailbox: Pubkey,
}

/// Initialized configuration account.
pub type RouterConfigAccount = AccountData<RouterConfig>;

impl SizedData for RouterConfig {
    fn size(&self) -> usize {
        32
    }
}

impl RouterConfig {
    /// Loads only this program's initialized canonical configuration PDA.
    pub fn load(program_id: &Pubkey, account: &AccountInfo) -> Result<Box<Self>, ProgramError> {
        if account.key != &config_address(program_id).0 || account.owner != program_id {
            return Err(ProgramError::InvalidArgument);
        }
        RouterConfigAccount::fetch_data(&mut &account.try_borrow_data()?[..])?
            .ok_or(ProgramError::UninitializedAccount)
    }
}

/// Derives the router's configuration PDA.
pub fn config_address(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(CONFIG_SEEDS, program_id)
}

/// Derives an ICA authority using the same identity fields as EVM ICAs.
/// No account allocation is needed to sign CPIs with this PDA.
pub fn interchain_account_address(
    program_id: &Pubkey,
    origin: u32,
    owner: &H256,
    router: &H256,
    ism: &H256,
    salt: &H256,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        interchain_account_seeds!(origin, owner, router, ism, salt),
        program_id,
    )
}
