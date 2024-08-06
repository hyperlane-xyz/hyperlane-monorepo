use access_control::AccessControl;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use hyperlane_sealevel_igp::instruction::{
    Instruction as IgpInstruction, PayForGas as IgpPayForGas,
};
use hyperlane_sealevel_mailbox::instruction::{
    Instruction as MailboxInstruction, OutboxDispatch as MailboxOutboxDispatch,
};
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{get_return_data, invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use std::collections::HashMap;

use crate::{HyperlaneConnectionClient, HyperlaneConnectionClientRecipient};

/// Configuration for a remote router.
#[derive(Debug, Clone, PartialEq, BorshDeserialize, BorshSerialize)]
pub struct RemoteRouterConfig {
    /// The domain of the remote router.
    pub domain: u32,
    /// The remote router.
    pub router: Option<H256>,
}

/// The Hyperlane router pattern.
pub trait HyperlaneRouter {
    /// Returns the router for the provided origin, or None if no router is enrolled.
    fn router(&self, origin: u32) -> Option<&H256>;

    /// Returns Err if `maybe_router` is not the remote router for the provided origin.
    fn only_remote_router(&self, origin: u32, maybe_router: &H256) -> Result<(), ProgramError> {
        if !self.is_remote_router(origin, maybe_router) {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(())
    }

    /// Enrolls a remote router.
    fn enroll_remote_router(&mut self, config: RemoteRouterConfig);

    /// Enrolls multiple remote routers.
    fn enroll_remote_routers(&mut self, configs: Vec<RemoteRouterConfig>) {
        for config in configs {
            self.enroll_remote_router(config);
        }
    }

    /// Returns true if `maybe_router` is the remote router for the provided origin.
    fn is_remote_router(&self, origin: u32, maybe_router: &H256) -> bool {
        self.router(origin) == Some(maybe_router)
    }
}

/// The Hyperlane router pattern with setters restricted to the access control owner.
pub trait HyperlaneRouterAccessControl: HyperlaneRouter + AccessControl {
    /// Enrolls a remote router if the provided `maybe_owner` is a signer and is the access control owner.
    /// Otherwise, returns an error.
    fn enroll_remote_router_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        config: RemoteRouterConfig,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.enroll_remote_router(config);
        Ok(())
    }

    /// Enrolls multiple remote routers if the provided `maybe_owner` is a signer and is the access control owner.
    /// Otherwise, returns an error.
    fn enroll_remote_routers_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        configs: Vec<RemoteRouterConfig>,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.enroll_remote_routers(configs);
        Ok(())
    }
}

// Auto-implement
impl<T> HyperlaneRouterAccessControl for T where T: HyperlaneRouter + AccessControl {}

/// The Hyperlane router pattern with a helper function to dispatch messages
/// to remote routers.
pub trait HyperlaneRouterDispatch: HyperlaneRouter + HyperlaneConnectionClient {
    /// Dispatches a message to the remote router for the provided destination domain.
    fn dispatch(
        &self,
        program_id: &Pubkey,
        dispatch_authority_seeds: &[&[u8]],
        destination_domain: u32,
        message_body: Vec<u8>,
        account_metas: Vec<AccountMeta>,
        account_infos: &[AccountInfo],
    ) -> Result<H256, ProgramError> {
        // The recipient is the remote router, which must be enrolled.
        let recipient = *self
            .router(destination_domain)
            .ok_or(ProgramError::InvalidArgument)?;

        let dispatch_instruction = MailboxInstruction::OutboxDispatch(MailboxOutboxDispatch {
            sender: *program_id,
            destination_domain,
            recipient,
            message_body,
        });
        let mailbox = self.mailbox();
        let mailbox_ixn = Instruction {
            program_id: *mailbox,
            data: dispatch_instruction.into_instruction_data()?,
            accounts: account_metas,
        };
        // Call the Mailbox program to dispatch the message.
        invoke_signed(&mailbox_ixn, account_infos, &[dispatch_authority_seeds])?;

        // Parse the message ID from the return data from the prior dispatch.
        let (returning_program_id, returned_data) =
            get_return_data().ok_or(ProgramError::InvalidArgument)?;
        // The mailbox itself doesn't make any CPIs, but as a sanity check we confirm
        // that the return data is from the mailbox.
        if returning_program_id != *mailbox {
            return Err(ProgramError::InvalidArgument);
        }
        let message_id: H256 =
            H256::try_from_slice(&returned_data).map_err(|_| ProgramError::InvalidArgument)?;

        Ok(message_id)
    }

    /// Dispatches a message to the remote router for the provided destination domain,
    /// paying for gas with the IGP.
    /// Errors if there is no IGP configured.
    #[allow(clippy::too_many_arguments)]
    fn dispatch_with_gas(
        &self,
        program_id: &Pubkey,
        dispatch_authority_seeds: &[&[u8]],
        destination_domain: u32,
        message_body: Vec<u8>,
        gas_amount: u64,
        dispatch_account_metas: Vec<AccountMeta>,
        dispatch_account_infos: &[AccountInfo],
        payment_account_metas: Vec<AccountMeta>,
        payment_account_infos: &[AccountInfo],
    ) -> Result<H256, ProgramError> {
        let message_id = self.dispatch(
            program_id,
            dispatch_authority_seeds,
            destination_domain,
            message_body,
            dispatch_account_metas,
            dispatch_account_infos,
        )?;

        // Call the IGP to pay for gas.
        let (igp_program_id, _) = self
            .interchain_gas_paymaster()
            .ok_or(ProgramError::InvalidArgument)?;

        let igp_ixn = Instruction::new_with_borsh(
            *igp_program_id,
            &IgpInstruction::PayForGas(IgpPayForGas {
                message_id,
                destination_domain,
                gas_amount,
            }),
            payment_account_metas,
        );

        invoke(&igp_ixn, payment_account_infos)?;

        Ok(message_id)
    }
}

// Auto-implement
impl<T> HyperlaneRouterDispatch for T where T: HyperlaneRouter + HyperlaneConnectionClient {}

/// The Hyperlane router pattern with a helper function to ensure messages
/// come only via the Mailbox & from an enrolled remote router.
pub trait HyperlaneRouterMessageRecipient:
    HyperlaneRouter + HyperlaneConnectionClientRecipient
{
    /// Returns Err if `maybe_mailbox_process_authority` is not a signer or is not the
    /// Mailbox's process authority for this recipient, or if the sender is not the
    /// remote router for the provided origin.
    fn ensure_valid_router_message(
        &self,
        maybe_mailbox_process_authority: &AccountInfo,
        origin: u32,
        sender: &H256,
    ) -> Result<(), ProgramError> {
        // First ensure that the Mailbox's process authority for this recipient
        // is a signer.
        self.ensure_mailbox_process_authority_signer(maybe_mailbox_process_authority)?;

        // Now make sure the sender is really a remote router.
        self.only_remote_router(origin, sender)
    }
}

// Auto-implement
impl<T> HyperlaneRouterMessageRecipient for T where
    T: HyperlaneRouter + HyperlaneConnectionClientRecipient
{
}

/// A default implementation of `HyperlaneRouter` for `HashMap<u32, H256>`.
impl HyperlaneRouter for HashMap<u32, H256> {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.get(&origin)
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        match config.router {
            Some(router) => {
                self.insert(config.domain, router);
            }
            None => {
                self.remove(&config.domain);
            }
        }

        msg!(
            "Set domain {} remote router to {:?}",
            config.domain,
            config.router
        );
    }
}
