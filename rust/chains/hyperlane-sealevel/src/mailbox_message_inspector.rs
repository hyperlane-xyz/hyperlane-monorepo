use std::sync::{Arc, Mutex};

use hyperlane_core::HyperlaneMessage;

use crate::solana::{
    instruction::AccountMeta,
    pubkey::Pubkey
};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("the message's recipient is not the program ID for this inspector")]
    IncorrectProgramId,
    #[error("the contained message body was invalid")]
    InvalidMessageBody,
}

pub struct Inspection {
    pub accounts: Vec<AccountMeta>,
}

pub trait Inspector {
    fn program_id(&self) -> Pubkey;

    fn inspect(&self, payer: &Pubkey, message: &HyperlaneMessage) -> Result<Inspection, Error> {
        if self.program_id() != Pubkey::new_from_array(message.recipient.into()) {
            return Err(Error::IncorrectProgramId);
        }
        self.inspect_impl(payer, message)
    }

    fn inspect_impl(&self, payer: &Pubkey, message: &HyperlaneMessage) -> Result<Inspection, Error>;
}

impl<T> Inspector for Arc<Mutex<T>>
where
    T: Inspector
{
    fn program_id(&self) -> Pubkey {
        self.lock().unwrap().program_id()
    }

    fn inspect(&self, payer: &Pubkey, message: &HyperlaneMessage) -> Result<Inspection, Error> {
        let inner = self.lock().unwrap();
        if inner.program_id() != Pubkey::new_from_array(message.recipient.into()) {
            return Err(Error::IncorrectProgramId);
        }
        inner.inspect_impl(payer, message)
    }

    fn inspect_impl(
        &self,
        payer: &Pubkey,
        message: &HyperlaneMessage
    ) -> Result<Inspection, Error> {
        self.lock().unwrap().inspect_impl(payer, message)
    }
}
