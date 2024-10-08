//! Hyperlane Sealevel Mailbox data account layouts.

use core::cell::RefMut;
use std::io::Read;

use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{accumulator::incremental::IncrementalMerkle as MerkleTree, H256};
use solana_program::{
    account_info::AccountInfo, clock::Slot, program_error::ProgramError, pubkey::Pubkey,
};

use crate::{mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds};

/// The Inbox account.
pub type InboxAccount = AccountData<Inbox>;

/// The Inbox account data, which is used when processing messages.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Inbox {
    /// The local domain.
    pub local_domain: u32,
    /// The bump seed of the inbox PDA.
    pub inbox_bump_seed: u8,
    /// The default ISM.
    pub default_ism: Pubkey,
    /// The number of messages processed. Used for easy indexing of processed messages.
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
    /// Verifies that the given account is the canonical Inbox PDA and returns the deserialized inner data.
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        inbox_account_info: &AccountInfo<'_>,
    ) -> Result<Self, ProgramError> {
        let inbox = InboxAccount::fetch(&mut &inbox_account_info.data.borrow()[..])?.into_inner();
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

    /// Verifies that the given account is the canonical Inbox PDA, and returns the deserialized inner data
    /// alongside a RefMut of the account data.
    /// Intended to be used when the account data's RefMut is required, e.g. as a
    /// reentrancy guard.
    pub fn verify_account_and_fetch_inner_with_data_refmut<'a, 'b>(
        program_id: &'b Pubkey,
        inbox_account_info: &'b AccountInfo<'a>,
    ) -> Result<(Self, RefMut<'b, &'a mut [u8]>), ProgramError> {
        let data_refmut = inbox_account_info.try_borrow_mut_data()?;

        let inbox = InboxAccount::fetch(&mut &data_refmut[..])?.into_inner();
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

        Ok((*inbox, data_refmut))
    }
}

/// The Outbox account.
pub type OutboxAccount = AccountData<Outbox>;

/// The Outbox account data, which is used when dispatching messages.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Eq)]
pub struct Outbox {
    /// The local domain.
    pub local_domain: u32,
    /// The bump seed of the outbox PDA.
    pub outbox_bump_seed: u8,
    /// The owner of this program, which has privileged permissions.
    pub owner: Option<Pubkey>,
    /// The merkle tree of dispatched messages.
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
    /// Verifies that the given account is the canonical Outbox PDA and returns the deserialized inner data.
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        outbox_account_info: &AccountInfo,
    ) -> Result<Self, ProgramError> {
        let outbox =
            OutboxAccount::fetch(&mut &outbox_account_info.data.borrow()[..])?.into_inner();
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

/// An account corresponding to a dispatched message.
pub type DispatchedMessageAccount = AccountData<DispatchedMessage>;

/// A discriminator used to easily identify dispatched message accounts.
/// This is the first 8 bytes of the account data.
pub const DISPATCHED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"DISPATCH";

/// A dispatched message.
#[derive(Debug, Default, Eq, PartialEq)]
pub struct DispatchedMessage {
    /// The discriminator, intended to be set to `DISPATCHED_MESSAGE_DISCRIMINATOR`.
    pub discriminator: [u8; 8],
    /// The nonce of the message.
    pub nonce: u32,
    /// The slot in which the message was dispatched.
    pub slot: Slot,
    /// The unique message pubkey used when the message was dispatched.
    pub unique_message_pubkey: Pubkey,
    /// The encoded message.
    pub encoded_message: Vec<u8>,
}

impl DispatchedMessage {
    /// Creates a new dispatched message.
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

/// For tighter packing and explicit endianness, we implement our own serialization.
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

/// For tighter packing, explicit endianness, and errors on an invalid discriminator, we implement our own deserialization.
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

/// An account corresponding to a processed message.
pub type ProcessedMessageAccount = AccountData<ProcessedMessage>;

/// A discriminator used to easily identify processed message accounts.
pub const PROCESSED_MESSAGE_DISCRIMINATOR: &[u8; 8] = b"PROCESSD";

/// A processed message.
#[derive(Debug, Default, Eq, PartialEq, BorshSerialize)]
pub struct ProcessedMessage {
    /// The discriminator, intended to be set to `PROCESSED_MESSAGE_DISCRIMINATOR`.
    pub discriminator: [u8; 8],
    /// The sequence of the processed message, which increases from 0 for each processed message.
    /// This way, we can easily index processed messages.
    pub sequence: u64,
    /// The message ID of the processed message.
    pub message_id: H256,
    /// The slot in which the message was processed.
    pub slot: Slot,
}

impl ProcessedMessage {
    /// Creates a new processed message.
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

/// To error upon invalid data, we implement our own deserialization.
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
    fn test_outbox_ser_deser() {
        let outbox = Outbox {
            local_domain: 420,
            outbox_bump_seed: 69,
            owner: Some(Pubkey::new_unique()),
            tree: MerkleTree::default(),
        };

        let mut serialized = vec![];
        outbox.serialize(&mut serialized).unwrap();

        let deserialized = Outbox::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(outbox, deserialized);
        assert_eq!(serialized.len(), outbox.size());
    }

    #[test]
    fn test_inbox_ser_deser() {
        let inbox = Inbox {
            local_domain: 420,
            inbox_bump_seed: 69,
            default_ism: Pubkey::new_unique(),
            processed_count: 69696969,
        };

        let mut serialized = vec![];
        inbox.serialize(&mut serialized).unwrap();

        let deserialized = Inbox::deserialize(&mut serialized.as_slice()).unwrap();

        assert_eq!(inbox, deserialized);
        assert_eq!(serialized.len(), inbox.size());
    }

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
