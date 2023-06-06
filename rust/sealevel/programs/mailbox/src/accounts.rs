//! Hyperlane Sealevel Mailbox data account layouts.

use std::io::Read;

use access_control::AccessControl;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{accumulator::incremental::IncrementalMerkle as MerkleTree, H256};
use solana_program::{
    account_info::AccountInfo, clock::Slot, program_error::ProgramError, pubkey::Pubkey,
};

use crate::{error::Error, mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds};

pub trait SizedData {
    fn size(&self) -> usize;
}

// FIXME should probably define another trait rather than use Default for this as a valid but
// uninitialized object in rust is a big no no.
pub trait Data: BorshDeserialize + BorshSerialize + Default {}
impl<T> Data for T where T: BorshDeserialize + BorshSerialize + Default {}

/// Account data structure wrapper type that handles initialization and (de)serialization.
///
/// (De)serialization is done with borsh and the "on-disk" format is as follows:
/// {
///     initialized: bool,
///     data: T,
/// }
#[derive(Debug, Default)]
pub struct AccountData<T> {
    data: Box<T>,
}

impl<T> From<T> for AccountData<T> {
    fn from(data: T) -> Self {
        Self {
            data: Box::new(data),
        }
    }
}

impl<T> From<Box<T>> for AccountData<T> {
    fn from(data: Box<T>) -> Self {
        Self { data }
    }
}

impl<T> SizedData for AccountData<T>
where
    T: SizedData,
{
    fn size(&self) -> usize {
        // Add an extra byte for the initialized flag.
        1 + self.data.size()
    }
}

impl<T> AccountData<T>
where
    T: Data,
{
    pub fn into_inner(self) -> Box<T> {
        self.data
    }

    // TODO: better name here?
    pub fn fetch_data(buf: &mut &[u8]) -> Result<Option<Box<T>>, ProgramError> {
        if buf.is_empty() {
            return Ok(None);
        }
        // Account data is zero initialized.
        let initialized = bool::deserialize(buf)?;
        let data = if initialized {
            Some(T::deserialize(buf).map(Box::new)?)
        } else {
            None
        };
        Ok(data)
    }

    pub fn fetch(buf: &mut &[u8]) -> Result<Self, ProgramError> {
        Ok(Self::from(Self::fetch_data(buf)?.unwrap_or_default()))
    }

    // Optimisically write then realloc on failure.
    // If we serialize and calculate len before realloc we will waste heap space as there is no
    // free(). Tradeoff between heap usage and compute budget.
    pub fn store<'a>(
        &self,
        account: &AccountInfo<'a>,
        allow_realloc: bool,
    ) -> Result<(), ProgramError> {
        if !account.is_writable || account.executable {
            return Err(ProgramError::from(Error::AccountReadOnly));
        }
        let realloc_increment = 1024;
        loop {
            let mut guard = account.try_borrow_mut_data()?;
            let data = &mut *guard;
            let data_len = data.len();

            // Create a new slice so that this new slice
            // is updated to point to the unwritten data during serialization.
            // Otherwise, if the account `data` is used directly, `data` will be
            // the account data itself will be updated to point to unwritten data!
            let mut writable_data: &mut [u8] = &mut data[..];

            match true
                .serialize(&mut writable_data)
                .and_then(|_| self.data.serialize(&mut writable_data))
            {
                Ok(_) => break,
                Err(err) => match err.kind() {
                    std::io::ErrorKind::WriteZero => {
                        if !allow_realloc {
                            return Err(ProgramError::BorshIoError(err.to_string()));
                        }
                    }
                    _ => return Err(ProgramError::BorshIoError(err.to_string())),
                },
            };
            drop(guard);
            if cfg!(target_os = "solana") {
                account.realloc(data_len + realloc_increment, false)?;
            } else {
                panic!("realloc() is only supported on the SVM");
            }
        }
        Ok(())
    }
}

pub type InboxAccount = AccountData<Inbox>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Inbox {
    pub local_domain: u32,
    pub inbox_bump_seed: u8,
    pub default_ism: Pubkey,
    pub processed_count: u64,
}

impl SizedData for Inbox {
    fn size(&self) -> usize {
        // 4 byte local_domain
        // 1 byte inbox_bump_seed
        // 32 byte default_ism
        // 8 byte processed_count
        4 + 1 + 32 + 8
    }
}

impl Inbox {
    pub fn verify_account_and_fetch_inner<'a>(
        program_id: &Pubkey,
        inbox_account_info: &AccountInfo<'a>,
    ) -> Result<Self, ProgramError> {
        let inbox =
            InboxAccount::fetch(&mut &inbox_account_info.data.borrow_mut()[..])?.into_inner();
        let expected_inbox_key = Pubkey::create_program_address(
            mailbox_inbox_pda_seeds!(inbox.inbox_bump_seed),
            program_id,
        )?;
        if inbox_account_info.key != &expected_inbox_key {
            return Err(ProgramError::InvalidArgument);
        }
        if inbox_account_info.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }

        Ok(*inbox)
    }
}

pub type OutboxAccount = AccountData<Outbox>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Outbox {
    pub local_domain: u32,
    pub outbox_bump_seed: u8,
    pub owner: Option<Pubkey>,
    pub tree: MerkleTree,
}

impl SizedData for Outbox {
    fn size(&self) -> usize {
        // 4 byte local_domain
        // 1 byte outbox_bump_seed
        // 33 byte owner (1 byte enum variant, 32 byte pubkey)
        // 1032 byte tree (32 * 32 = 1024 byte branch, 8 byte count)
        4 + 1 + 33 + 1032
    }
}

impl AccessControl for Outbox {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = owner;
        Ok(())
    }
}

impl Outbox {
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        outbox_account_info: &AccountInfo,
    ) -> Result<Self, ProgramError> {
        let outbox =
            OutboxAccount::fetch(&mut &outbox_account_info.data.borrow_mut()[..])?.into_inner();
        let expected_outbox_key = Pubkey::create_program_address(
            mailbox_outbox_pda_seeds!(outbox.outbox_bump_seed),
            program_id,
        )?;
        if outbox_account_info.key != &expected_outbox_key {
            return Err(ProgramError::InvalidArgument);
        }
        if outbox_account_info.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }

        Ok(*outbox)
    }
}

pub type DispatchedMessageAccount = AccountData<DispatchedMessage>;

// TODO change?
const DISPATCHED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"DISPATCH";

#[derive(Debug, Default, Eq, PartialEq)]
pub struct DispatchedMessage {
    pub discriminator: [u8; 8],
    pub nonce: u32,
    pub slot: Slot,
    pub unique_message_pubkey: Pubkey,
    pub encoded_message: Vec<u8>,
}

impl DispatchedMessage {
    pub fn new(
        nonce: u32,
        slot: Slot,
        unique_message_pubkey: Pubkey,
        encoded_message: Vec<u8>,
    ) -> Self {
        Self {
            discriminator: *DISPATCHED_MESSAGE_DISCRIMINATOR,
            nonce,
            slot,
            unique_message_pubkey,
            encoded_message,
        }
    }
}

impl SizedData for DispatchedMessage {
    fn size(&self) -> usize {
        // 8 byte discriminator
        // 4 byte nonce
        // 8 byte slot
        // 32 byte unique_message_pubkey
        // encoded_message.len() bytes
        8 + 4 + 8 + 32 + self.encoded_message.len()
    }
}

impl BorshSerialize for DispatchedMessage {
    fn serialize<W: std::io::Write>(&self, writer: &mut W) -> std::io::Result<()> {
        writer.write_all(DISPATCHED_MESSAGE_DISCRIMINATOR)?;
        writer.write_all(&self.nonce.to_le_bytes())?;
        writer.write_all(&self.slot.to_le_bytes())?;
        writer.write_all(&self.unique_message_pubkey.to_bytes())?;
        writer.write_all(&self.encoded_message)?;
        Ok(())
    }
}

impl BorshDeserialize for DispatchedMessage {
    fn deserialize(reader: &mut &[u8]) -> std::io::Result<Self> {
        let mut discriminator = [0u8; 8];
        reader.read_exact(&mut discriminator)?;
        if &discriminator != DISPATCHED_MESSAGE_DISCRIMINATOR {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid discriminator",
            ));
        }

        let mut nonce = [0u8; 4];
        reader.read_exact(&mut nonce)?;

        let mut slot = [0u8; 8];
        reader.read_exact(&mut slot)?;

        let mut unique_message_pubkey = [0u8; 32];
        reader.read_exact(&mut unique_message_pubkey)?;

        let mut encoded_message = vec![];
        reader.read_to_end(&mut encoded_message)?;

        Ok(Self {
            discriminator,
            nonce: u32::from_le_bytes(nonce),
            slot: u64::from_le_bytes(slot),
            unique_message_pubkey: Pubkey::new_from_array(unique_message_pubkey),
            encoded_message,
        })
    }
}

pub type ProcessedMessageAccount = AccountData<ProcessedMessage>;

const PROCESSED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"PROCESSD";

#[derive(Debug, Default, Eq, PartialEq, BorshSerialize)]
pub struct ProcessedMessage {
    pub discriminator: [u8; 8],
    pub sequence: u64,
    pub message_id: H256,
    pub slot: Slot,
}

impl ProcessedMessage {
    pub fn new(sequence: u64, message_id: H256, slot: Slot) -> Self {
        Self {
            discriminator: *PROCESSED_MESSAGE_DISCRIMINATOR,
            sequence,
            message_id,
            slot,
        }
    }
}

impl SizedData for ProcessedMessage {
    fn size(&self) -> usize {
        // 8 byte discriminator
        // 8 byte sequence
        // 32 byte message_id
        // 8 byte slot
        8 + 8 + 32 + 8
    }
}

impl BorshDeserialize for ProcessedMessage {
    fn deserialize(reader: &mut &[u8]) -> std::io::Result<Self> {
        let mut discriminator = [0u8; 8];
        reader.read_exact(&mut discriminator)?;
        if &discriminator != PROCESSED_MESSAGE_DISCRIMINATOR {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid discriminator",
            ));
        }

        let mut sequence = [0u8; 8];
        reader.read_exact(&mut sequence)?;

        let mut message_id = [0u8; 32];
        reader.read_exact(&mut message_id)?;

        let mut slot = [0u8; 8];
        reader.read_exact(&mut slot)?;

        Ok(Self {
            discriminator,
            sequence: u64::from_le_bytes(sequence),
            message_id: H256::from_slice(&message_id),
            slot: u64::from_le_bytes(slot),
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    use solana_program::pubkey::Pubkey;

    #[test]
    fn test_dispatched_message_ser_deser() {
        let dispatched_message = DispatchedMessage::new(
            420,
            69696969,
            Pubkey::new_unique(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 0],
        );

        let mut serialized = vec![];
        dispatched_message.serialize(&mut serialized).unwrap();

        let deserialized = DispatchedMessage::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(dispatched_message, deserialized);
        assert_eq!(serialized.len(), dispatched_message.size());
    }

    #[test]
    fn test_processed_message_ser_deser() {
        let processed_message = ProcessedMessage::new(420420420, H256::random(), 69696969);

        let mut serialized = vec![];
        processed_message.serialize(&mut serialized).unwrap();

        let deserialized = ProcessedMessage::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(processed_message, deserialized);
        assert_eq!(serialized.len(), processed_message.size());
    }
}
