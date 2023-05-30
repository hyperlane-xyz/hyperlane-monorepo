use hyperlane_core::H256;
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use std::collections::HashMap;

use hyperlane_sealevel_mailbox::instruction::{
    Instruction as MailboxInstruction, OutboxDispatch as MailboxOutboxDispatch,
};

pub trait HyperlaneConnectionClient {
    fn mailbox(&self) -> &Pubkey;

    fn interchain_gas_paymaster(&self) -> Option<&Pubkey>;

    fn interchain_security_module(&self) -> Option<&Pubkey>;
}

pub trait HyperlaneConnectionClientRecipient {
    fn mailbox_process_authority(&self) -> &Pubkey;
}

pub struct RemoteRouterConfig {
    pub domain: u32,
    pub router: Option<H256>,
}

pub trait HyperlaneRouter {
    fn router(&self, origin: u32) -> Option<&H256>;

    fn only_remote_router(&self, origin: u32, maybe_router: H256) -> Result<(), ProgramError> {
        if !self.is_remote_router(origin, maybe_router) {
            return Err(ProgramError::InvalidInstructionData);
        }
        Ok(())
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig);

    fn enroll_remote_routers(&mut self, configs: Vec<RemoteRouterConfig>) {
        for config in configs {
            self.enroll_remote_router(config);
        }
    }

    fn is_remote_router(&self, origin: u32, maybe_router: H256) -> bool {
        self.router(origin) == Some(&maybe_router)
    }
}

impl HyperlaneRouter for HashMap<u32, Option<H256>> {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.get(&origin).map(|r| r.as_ref()).flatten()
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        self.insert(config.domain, config.router);
        msg!(
            "Set domain {} remote router to {:?}",
            config.domain,
            config.router
        );
    }
}

pub trait HyperlaneRouterDispatch: HyperlaneRouter + HyperlaneConnectionClient {
    fn dispatch(
        &self,
        program_id: &Pubkey,
        dispatch_authority_seeds: &[&[u8]],
        destination_domain: u32,
        message_body: Vec<u8>,
        account_metas: Vec<AccountMeta>,
        account_infos: &[AccountInfo],
    ) -> Result<(), ProgramError> {
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
        let mailbox_ixn = Instruction {
            program_id: *self.mailbox(),
            data: dispatch_instruction.into_instruction_data()?,
            accounts: account_metas,
        };
        // Call the Mailbox program to dispatch the message.
        invoke_signed(&mailbox_ixn, account_infos, &[dispatch_authority_seeds])
    }
}
