use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

pub mod router;

/// Getters for the HyperlaneConnectionClient.
pub trait HyperlaneConnectionClient {
    fn mailbox(&self) -> &Pubkey;

    fn interchain_gas_paymaster(&self) -> Option<&Pubkey>;

    fn interchain_security_module(&self) -> Option<&Pubkey>;
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
