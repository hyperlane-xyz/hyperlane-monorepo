use access_control::AccessControl;
use borsh::BorshSerialize;
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use solana_program::{
    account_info::AccountInfo, program::set_return_data, program_error::ProgramError,
    pubkey::Pubkey,
};

pub mod gas_router;
pub mod router;

/// Getters for the HyperlaneConnectionClient.
pub trait HyperlaneConnectionClient {
    fn mailbox(&self) -> &Pubkey;

    fn interchain_gas_paymaster(&self) -> Option<&(Pubkey, InterchainGasPaymasterType)>;

    fn interchain_security_module(&self) -> Option<&Pubkey>;

    fn set_interchain_security_module_return_data(&self) {
        let ism: Option<Pubkey> = self.interchain_security_module().cloned();
        set_return_data(
            &ism.try_to_vec()
                .map_err(|err| ProgramError::BorshIoError(err.to_string()))
                .unwrap()[..],
        );
    }
}

pub trait HyperlaneConnectionClientSetter {
    fn set_mailbox(&mut self, new_mailbox: Pubkey);

    fn set_interchain_gas_paymaster(
        &mut self,
        new_igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    );

    fn set_interchain_security_module(&mut self, new_ism: Option<Pubkey>);
}

pub trait HyperlaneConnectionClientSetterAccessControl:
    HyperlaneConnectionClientSetter + AccessControl
{
    fn set_mailbox_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        new_mailbox: Pubkey,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.set_mailbox(new_mailbox);

        Ok(())
    }

    fn set_interchain_gas_paymaster_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        new_igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.set_interchain_gas_paymaster(new_igp);

        Ok(())
    }

    fn set_interchain_security_module_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        new_ism: Option<Pubkey>,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.set_interchain_security_module(new_ism);

        Ok(())
    }
}

/// A recipient of Hyperlane messages.
pub trait HyperlaneConnectionClientRecipient {
    fn mailbox_process_authority(&self) -> &Pubkey;

    fn ensure_mailbox_process_authority_signer(
        &self,
        maybe_authority: &AccountInfo,
    ) -> Result<(), ProgramError> {
        if self.mailbox_process_authority() != maybe_authority.key {
            return Err(ProgramError::InvalidArgument);
        }
        if !maybe_authority.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }
        Ok(())
    }
}
