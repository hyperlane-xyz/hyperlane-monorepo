//! Accounts used by the ValidatorAnnounce program.

use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use crate::validator_announce_pda_seeds;

/// An account that holds common data used for verifying validator announcements.
pub type ValidatorAnnounceAccount = AccountData<ValidatorAnnounce>;

/// Data used for verifying validator announcements.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, Clone, PartialEq, Eq)]
pub struct ValidatorAnnounce {
    /// The bump seed used to derive the PDA for this account.
    pub bump_seed: u8,
    /// The local Mailbox program.
    pub mailbox: Pubkey,
    /// The local domain.
    pub local_domain: u32,
}

impl SizedData for ValidatorAnnounce {
    fn size(&self) -> usize {
        1 + 32 + 4
    }
}

impl ValidatorAnnounce {
    /// Verifies that the provided account info is the expected canonical ValidatorAnnounce PDA account.
    pub fn verify_self_account_info(
        &self,
        program_id: &Pubkey,
        maybe_self: &AccountInfo,
    ) -> Result<(), ProgramError> {
        let expected_key = Pubkey::create_program_address(
            validator_announce_pda_seeds!(self.bump_seed),
            program_id,
        )?;
        if maybe_self.owner != program_id || maybe_self.key != &expected_key {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(())
    }
}

/// An account that holds a validator's announced storage locations.
/// It is a PDA based off the validator's address, and can therefore
/// hold up to 10 KiB of data.
pub type ValidatorStorageLocationsAccount = AccountData<ValidatorStorageLocations>;

/// Storage locations for a validator.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, Clone, PartialEq, Eq)]
pub struct ValidatorStorageLocations {
    /// The bump seed used to derive the PDA for this account.
    pub bump_seed: u8,
    /// Storage locations for this validator.
    pub storage_locations: Vec<String>,
}

impl SizedData for ValidatorStorageLocations {
    /// This is O(storage_locations.len()), and is therefore
    /// not suggested to be used apart from the very first
    /// announcement for a validator.
    ///
    /// For subsequent announcements for the validator, the
    /// new size can be determined by adding size required by
    /// the new storage location to the account data's existing size.
    /// I.e. 4 (for the len of the location) + storage_location.len()
    /// to the AccountInfo's data_len.
    ///
    /// This is tested in functional tests.
    fn size(&self) -> usize {
        // 1 byte bump seed
        // 4 byte len of storage_locations
        // for each storage location:
        //   4 byte len of the storage location
        //   len bytes of the storage location
        1 + 4
            + self
                .storage_locations
                .iter()
                .map(|s| ValidatorStorageLocations::size_increase_for_new_storage_location(s))
                .sum::<usize>()
    }
}

impl ValidatorStorageLocations {
    /// An O(1) method for determining how much to increase the size of the
    /// account data by when adding a new storage location.
    /// Only intended to be used for subsequent announcements for a validator,
    /// not the first announcement.
    pub fn size_increase_for_new_storage_location(new_storage_location: &str) -> usize {
        // The only difference in the account is the new storage location, which is Borsh-serialized
        // as the u32 length of the string + the Vec<u8> it is serialized into.
        // See https://borsh.io/ for details.
        4 + new_storage_location.len()
    }
}

/// An account whose presence is used as a replay protection mechanism.
/// Replay protection account addresses are PDAs based off the hash of
/// a validator's storage location. So these ultimately serve like a
/// HashMap to tell if a storage location has already been announced.
pub type ReplayProtectionAccount = AccountData<ReplayProtection>;

/// Empty account data used as a replay protection mechanism.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, Clone, PartialEq, Eq)]
pub struct ReplayProtection(pub ());

impl SizedData for ReplayProtection {
    fn size(&self) -> usize {
        0
    }
}
