//! Router configuration and deterministic interchain account authorities.

use std::collections::HashMap;

use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_connection_client::router::{HyperlaneRouter, RemoteRouterConfig};
use hyperlane_sealevel_interchain_security_module_interface::VERIFY_ACCOUNT_METAS_PDA_SEEDS;
use solana_program::{account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey};

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

/// Router configuration. Enrollment affects outgoing convenience calls only.
#[derive(BorshSerialize, BorshDeserialize, Default, Debug)]
pub struct RouterConfig {
    /// Mailbox authorized to deliver messages and used for outgoing messages.
    pub mailbox: Pubkey,
    /// Administrator for remote enrollment; initialized to the upgrade authority.
    pub owner: Option<Pubkey>,
    /// Enrolled destination routers, including explicitly enrolled zero addresses.
    pub routers: HashMap<u32, H256>,
    /// Destination ISMs. Unenrolling a router does not clear this mapping, as on EVM.
    pub isms: HashMap<u32, H256>,
}

/// Initialized configuration account.
pub type RouterConfigAccount = AccountData<RouterConfig>;

impl SizedData for RouterConfig {
    fn size(&self) -> usize {
        32 + 1
            + self.owner.map_or(0, |_| 32)
            + 4
            + 36 * self.routers.len()
            + 4
            + 36 * self.isms.len()
    }
}

impl RouterConfig {
    /// Returns the enrolled router, or zero when absent, like EVM `routers(domain)`.
    pub fn router(&self, domain: u32) -> H256 {
        self.routers.router(domain).copied().unwrap_or_default()
    }

    /// Returns the outgoing ISM, or zero for the destination mailbox default.
    pub fn ism(&self, domain: u32) -> H256 {
        self.isms.get(&domain).copied().unwrap_or_default()
    }

    /// Matches EVM ICA's immutable-defaults guard: both current values must be zero.
    pub fn enroll(&mut self, domain: u32, router: H256, ism: H256) -> Result<(), ProgramError> {
        if self.router(domain) != H256::zero() || self.ism(domain) != H256::zero() {
            msg!("Router and ISM defaults are immutable once set");
            return Err(ProgramError::InvalidArgument);
        }
        // Reuse the Hyp token primitive after ICA's immutable-defaults check;
        // the shared infallible setter cannot enforce that guard itself.
        self.routers.enroll_remote_router(RemoteRouterConfig {
            domain,
            router: Some(router),
        });
        self.isms.insert(domain, ism);
        msg!("Enrolled domain {} ISM {:?}", domain, ism);
        Ok(())
    }

    /// Removes an existing router only; retains its ISM, matching EVM.
    pub fn unenroll(&mut self, domain: u32) -> Result<(), ProgramError> {
        if self.routers.router(domain).is_none() {
            return Err(ProgramError::InvalidArgument);
        }
        self.routers.enroll_remote_router(RemoteRouterConfig {
            domain,
            router: None,
        });
        Ok(())
    }

    /// Loads only this program's initialized canonical configuration PDA.
    pub fn load(program_id: &Pubkey, account: &AccountInfo) -> Result<Box<Self>, ProgramError> {
        Self::verify_account(program_id, account)?;
        RouterConfigAccount::fetch_data(&mut &account.try_borrow_data()?[..])?
            .ok_or(ProgramError::UninitializedAccount)
    }

    /// Reads the mailbox prefix without allocating the outgoing enrollment maps.
    pub fn load_mailbox(
        program_id: &Pubkey,
        account: &AccountInfo,
    ) -> Result<Pubkey, ProgramError> {
        Self::verify_account(program_id, account)?;
        // RouterConfig begins with mailbox. AccountData checks the initialization
        // flag and deserializes only this first field, preserving the stored layout.
        AccountData::<Pubkey>::fetch_data(&mut &account.try_borrow_data()?[..])?
            .map(|mailbox| *mailbox)
            .ok_or(ProgramError::UninitializedAccount)
    }

    fn verify_account(program_id: &Pubkey, account: &AccountInfo) -> Result<(), ProgramError> {
        if account.key != &config_address(program_id).0 || account.owner != program_id {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }
}

impl AccessControl for RouterConfig {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = owner;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailbox_prefix_checks_account_and_initialization() {
        let program_id = Pubkey::new_unique();
        let key = config_address(&program_id).0;
        let mailbox = Pubkey::new_unique();
        let config = RouterConfigAccount::from(RouterConfig {
            mailbox,
            owner: Some(Pubkey::new_unique()),
            routers: HashMap::from([(1, H256::repeat_byte(2))]),
            isms: HashMap::from([(1, H256::repeat_byte(3))]),
        });
        let mut data = vec![0; config.size()];
        config.store_in_slice(&mut data).unwrap();
        let read = |key: &Pubkey, owner: &Pubkey, data: &mut [u8]| {
            let mut lamports = 0;
            let account = AccountInfo::new(key, false, false, &mut lamports, data, owner, false);
            RouterConfig::load_mailbox(&program_id, &account)
        };
        assert_eq!(read(&key, &program_id, &mut data), Ok(mailbox));
        assert_eq!(
            read(&Pubkey::new_unique(), &program_id, &mut data),
            Err(ProgramError::InvalidArgument)
        );
        assert_eq!(
            read(&key, &Pubkey::new_unique(), &mut data),
            Err(ProgramError::InvalidArgument)
        );
        for len in 1..33 {
            assert!(read(&key, &program_id, &mut data[..len]).is_err());
        }
        assert_eq!(
            read(&key, &program_id, &mut []),
            Err(ProgramError::UninitializedAccount)
        );
        data[0] = 0;
        assert_eq!(
            read(&key, &program_id, &mut data),
            Err(ProgramError::UninitializedAccount)
        );
    }
}
