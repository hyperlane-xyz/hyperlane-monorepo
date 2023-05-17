//! API for Hyperlane Sealevel Mailbox smart contract.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// Hyperlane mailbox protocol version.
pub const VERSION: u8 = 0;

/// Maximum bytes per message = 2 KiB (somewhat arbitrarily set to begin).
pub const MAX_MESSAGE_BODY_BYTES: usize = 2 * 2_usize.pow(10);

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init(Init),
    InboxProcess(InboxProcess),
    InboxSetDefaultModule(InboxSetDefaultModule),
    OutboxDispatch(OutboxDispatch),
    OutboxGetCount(OutboxQuery),
    OutboxGetLatestCheckpoint(OutboxQuery),
    OutboxGetRoot(OutboxQuery),
}

impl Instruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    pub local_domain: u32,
    pub auth_bump_seed: u8,
    pub inbox_bump_seed: u8,
    pub outbox_bump_seed: u8,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct OutboxDispatch {
    // The sender may not necessarily be the transaction payer so specify separately.
    pub sender: Pubkey,
    pub local_domain: u32,
    pub destination_domain: u32,
    pub recipient: H256,
    pub message_body: Vec<u8>,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct OutboxQuery {
    pub local_domain: u32,
}

// Note: maximum transaction size is ~1kB, so will need to use accounts for large messages.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InboxProcess {
    pub metadata: Vec<u8>, // Encoded Multi-Signature ISM data, or similar.
    pub message: Vec<u8>,  // Encoded HyperlaneMessage
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InboxSetDefaultModule {
    pub local_domain: u32,
    pub program_id: Pubkey,
    pub accounts: Vec<Pubkey>,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub enum IsmInstruction {
    Verify(IsmVerify),
    Type,
}

/// Instruction data format for an Interchain Security Module (ISM).
///
/// An ISM validates whether or not to accept a message. If the message should be rejected, the
/// program will return an error and execution of the calling program will stop.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub struct IsmVerify {
    /// Arbitrary data consumed by the ISM. Typically validator signatures, etc.
    pub metadata: Vec<u8>,
    /// The message to accept or reject.
    pub message: Vec<u8>,
}

impl IsmInstruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}

/// Generic instruction to allow program instruction data to be parsed as either instruction data
/// for a recipient CPI call from the mailbox or an arbitrary type T.
#[derive(Debug)]
pub enum MailboxRecipientInstruction<T> {
    MailboxRecipientCpi(RecipientInstruction),
    Custom(T),
}

// FIXME is mem::discriminant suitable to replace this?
#[derive(BorshSerialize, BorshDeserialize, Debug)]
#[repr(u8)]
enum MailboxRecipientInstructionKind {
    MailboxRecipientCpi = 0,
    Custom = 1,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
struct MailboxRecipientInstructionHeader {
    magic_number: u32,
    version: u8,
    instruction_kind: MailboxRecipientInstructionKind,
}

const MAILBOX_RECIPIENT_INSTRUCTION_SENTINEL: u32 = 0x69421269;
const MAILBOX_RECIPIENT_INSTRUCTION_VERSION: u8 = 1;

impl<T> MailboxRecipientInstruction<T>
where
    T: BorshDeserialize + BorshSerialize + std::fmt::Debug,
{
    pub fn new_mailbox_recipient_cpi(sender: H256, origin: u32, message: Vec<u8>) -> Self {
        Self::MailboxRecipientCpi(RecipientInstruction {
            sender,
            origin,
            message,
        })
    }

    pub fn new_custom(custom: T) -> Self {
        Self::Custom(custom)
    }

    // FIXME should we just manually impl Borsh here?
    pub fn from_instruction_data(mut data: &[u8]) -> Result<Self, ProgramError> {
        let header = MailboxRecipientInstructionHeader::deserialize(&mut data).map_err(|_| {
            solana_program::msg!("ERROR: {}:{}", file!(), line!()); // FIXME remove
            ProgramError::InvalidInstructionData
        })?;
        if header.magic_number != MAILBOX_RECIPIENT_INSTRUCTION_SENTINEL {
            solana_program::msg!("ERROR: {}:{}", file!(), line!()); // FIXME remove
            return Err(ProgramError::InvalidInstructionData)?;
        }
        if header.version != MAILBOX_RECIPIENT_INSTRUCTION_VERSION {
            solana_program::msg!("ERROR: {}:{}", file!(), line!()); // FIXME remove
            return Err(ProgramError::InvalidInstructionData)?;
        }
        match header.instruction_kind {
            MailboxRecipientInstructionKind::MailboxRecipientCpi => {
                RecipientInstruction::try_from_slice(data).map(Self::MailboxRecipientCpi)
            }
            MailboxRecipientInstructionKind::Custom => T::try_from_slice(data).map(Self::Custom),
        }
        .map_err(|_| {
            solana_program::msg!("ERROR: {}:{}", file!(), line!()); // FIXME remove
            ProgramError::InvalidInstructionData
        })
    }

    // FIXME should we just manually impl Borsh here?
    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        let header = MailboxRecipientInstructionHeader {
            magic_number: MAILBOX_RECIPIENT_INSTRUCTION_SENTINEL,
            version: MAILBOX_RECIPIENT_INSTRUCTION_VERSION,
            instruction_kind: match self {
                Self::MailboxRecipientCpi(_) => {
                    MailboxRecipientInstructionKind::MailboxRecipientCpi
                }
                Self::Custom(_) => MailboxRecipientInstructionKind::Custom,
            },
        };
        let mut data = header
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
        let inner_data = match self {
            Self::MailboxRecipientCpi(ixn) => ixn.try_to_vec(),
            Self::Custom(ixn) => ixn.try_to_vec(),
        }
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
        data.extend(inner_data);
        Ok(data)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct RecipientInstruction {
    pub sender: H256,
    pub origin: u32,
    pub message: Vec<u8>,
}
