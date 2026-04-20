//! Cross-collateral state accounts, PDA seed macros, and helpers.

use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// AccountData wrapper for CrossCollateralState.
pub type CrossCollateralStateAccount = AccountData<CrossCollateralState>;

/// PDA seeds for the cross-collateral state account.
#[macro_export]
macro_rules! cross_collateral_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"cross_collateral"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"cross_collateral", &[$bump_seed]]
    }};
}

/// PDA seeds for the cross-collateral dispatch authority.
#[macro_export]
macro_rules! cross_collateral_dispatch_authority_pda_seeds {
    () => {{
        &[b"hyperlane_cc", b"-", b"dispatch_authority"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_cc", b"-", b"dispatch_authority", &[$bump_seed]]
    }};
}

/// Cross-collateral state stored in a separate PDA.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct CrossCollateralState {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The bump seed for the CC dispatch authority PDA.
    pub dispatch_authority_bump: u8,
    /// The local domain ID, set at init.
    pub local_domain: u32,
    /// Enrolled CC routers per domain. Each domain maps to a set of router addresses.
    /// Uses BTreeMap and BTreeSet to ensure deterministic serialization and deserialization
    pub enrolled_routers: BTreeMap<u32, BTreeSet<H256>>,
}

impl CrossCollateralState {
    /// Checks if a router is enrolled for a given domain.
    pub fn is_enrolled_router(&self, domain: u32, router: &H256) -> bool {
        self.enrolled_routers
            .get(&domain)
            .is_some_and(|routers| routers.contains(router))
    }

    /// Checks if a router is authorized for a given domain.
    /// Checks both the CC enrolled routers and the base remote routers.
    pub fn is_authorized_router(
        &self,
        domain: u32,
        router: &H256,
        remote_routers: &HashMap<u32, H256>,
    ) -> bool {
        self.is_enrolled_router(domain, router)
            || remote_routers.get(&domain).is_some_and(|r| r == router)
    }

    /// Deserializes and verifies the CC state PDA against the expected address.
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        cc_state_account_info: &AccountInfo<'_>,
    ) -> Result<Self, ProgramError> {
        let cc_state =
            CrossCollateralStateAccount::fetch(&mut &cc_state_account_info.data.borrow()[..])?
                .into_inner();
        let cc_state_seeds: &[&[u8]] = cross_collateral_pda_seeds!(cc_state.bump);
        let expected_cc_state_key = Pubkey::create_program_address(cc_state_seeds, program_id)?;
        if cc_state_account_info.key != &expected_cc_state_key {
            return Err(ProgramError::InvalidArgument);
        }
        if cc_state_account_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(*cc_state)
    }
}

impl SizedData for CrossCollateralState {
    fn size(&self) -> usize {
        // bump
        std::mem::size_of::<u8>()
        // dispatch_authority_bump
        + std::mem::size_of::<u8>()
        // local_domain
        + std::mem::size_of::<u32>()
        // enrolled_routers map length prefix (Borsh uses u32)
        + std::mem::size_of::<u32>()
        // enrolled_routers entries: for each domain -> (u32 key + u32 vec_len + n * 32 bytes)
        + self.enrolled_routers.len() * std::mem::size_of::<u32>()
        + self.enrolled_routers.values().map(|routers| {
            std::mem::size_of::<u32>() + routers.len() * 32
        }).sum::<usize>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_state(routers: &[(u32, usize)]) -> CrossCollateralState {
        let mut enrolled = BTreeMap::new();
        for &(domain, count) in routers {
            let set: BTreeSet<H256> = (0..count).map(|_| H256::random()).collect();
            enrolled.insert(domain, set);
        }
        CrossCollateralState {
            bump: 1,
            dispatch_authority_bump: 2,
            local_domain: 1234,
            enrolled_routers: enrolled,
        }
    }

    #[test]
    fn test_cross_collateral_state_sized_data() {
        for routers in [
            vec![],
            vec![(100, 1)],
            vec![(100, 3)],
            vec![(100, 3), (200, 1), (300, 2)],
        ] {
            let state = make_state(&routers);
            assert_eq!(borsh::to_vec(&state).unwrap().len(), state.size());
        }
    }
}
