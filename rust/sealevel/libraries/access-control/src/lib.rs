use solana_program::{account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey};

pub trait AccessControl {
    fn owner(&self) -> Option<&Pubkey>;

    /// Returns Ok(()) if `maybe_owner` is the owner and is a signer.
    fn ensure_owner_signer(&self, maybe_owner: &AccountInfo) -> Result<(), ProgramError> {
        // Owner cannot be None.
        let owner = self.owner().ok_or(ProgramError::InvalidArgument)?;

        if !maybe_owner.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        if owner != maybe_owner.key {
            return Err(ProgramError::InvalidArgument);
        }
        Ok(())
    }

    /// Note this does not check that the existing owner is a signer,
    /// nor does it serialize the change to the account.
    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError>;

    /// Sets ownership if the `existing_owner` is the current owner and is a signer.
    /// Errors if `existing_owner` is not a signer or is not the current owner.
    /// Note this does not serialize the change to the account.
    fn transfer_ownership(
        &mut self,
        maybe_existing_owner: &AccountInfo,
        new_owner: Option<Pubkey>,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_existing_owner)?;
        self.set_owner(new_owner)?;
        msg!("Ownership transferred to {:?}", new_owner);
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;

    struct TestAccessControl {
        owner: Option<Pubkey>,
    }

    impl AccessControl for TestAccessControl {
        fn owner(&self) -> Option<&Pubkey> {
            self.owner.as_ref()
        }

        fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
            self.owner = new_owner;
            Ok(())
        }
    }

    #[test]
    fn test_ensure_owner_signer() {
        let owner = Pubkey::new_unique();
        let access_control = TestAccessControl { owner: Some(owner) };

        let mut owner_account_lamports = 0;
        let mut owner_account_data = vec![0; 0];
        // Is a signer and the owner
        let owner_account_info = AccountInfo::new(
            &owner,
            true,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &owner,
            false,
            0,
        );
        assert_eq!(
            access_control.ensure_owner_signer(&owner_account_info),
            Ok(())
        );

        // Not a signer, is the owner
        let owner_account_info = AccountInfo::new(
            &owner,
            false,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &owner,
            false,
            0,
        );
        assert_eq!(
            access_control.ensure_owner_signer(&owner_account_info),
            Err(ProgramError::MissingRequiredSignature),
        );

        // Is a signer, not the owner
        let non_owner = Pubkey::new_unique();
        let owner_account_info = AccountInfo::new(
            &non_owner,
            true,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &owner,
            false,
            0,
        );
        assert_eq!(
            access_control.ensure_owner_signer(&owner_account_info),
            Err(ProgramError::InvalidArgument),
        );
    }

    #[test]
    fn test_transfer_ownership() {
        let owner = Pubkey::new_unique();
        let mut access_control = TestAccessControl { owner: Some(owner) };

        let mut owner_account_lamports = 0;
        let mut owner_account_data = vec![0; 0];
        // Is a signer and the owner
        let owner_account_info = AccountInfo::new(
            &owner,
            true,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &owner,
            false,
            0,
        );

        let new_owner = Pubkey::new_unique();
        // Transfer ownership to new_owner
        assert_eq!(
            access_control.transfer_ownership(&owner_account_info, Some(new_owner)),
            Ok(())
        );
        assert_eq!(access_control.owner, Some(new_owner));

        // Now the old owner shouldn't be able to transfer ownership anymore
        assert_eq!(
            access_control.transfer_ownership(&owner_account_info, Some(new_owner)),
            Err(ProgramError::InvalidArgument),
        );

        // The new owner now, but not a signer
        let owner_account_info = AccountInfo::new(
            &new_owner,
            false,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &owner,
            false,
            0,
        );

        // Ensure it can't transfer ownership because it's not a signer
        assert_eq!(
            access_control.transfer_ownership(&owner_account_info, None),
            Err(ProgramError::MissingRequiredSignature),
        );

        // The new owner now, but a signer
        let owner_account_info = AccountInfo::new(
            &new_owner,
            true,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &owner,
            false,
            0,
        );

        // Transfer ownership to None
        assert_eq!(
            access_control.transfer_ownership(&owner_account_info, None),
            Ok(())
        );
        assert_eq!(access_control.owner, None);

        // Now the "new owner" shouldn't be able to transfer ownership anymore
        // because the owner is None
        assert_eq!(
            access_control.transfer_ownership(&owner_account_info, None),
            Err(ProgramError::InvalidArgument),
        );
    }
}
