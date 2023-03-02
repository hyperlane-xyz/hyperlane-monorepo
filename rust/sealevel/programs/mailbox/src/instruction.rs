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

/// Instruction data format for an Interchain Security Module (ISM).
///
/// An ISM validates whether or not to accept a message. If the message should be rejected, the
/// program will return an error and execution of the calling program will stop.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct IsmInstruction {
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

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct RecipientInstruction {
    pub sender: H256,
    pub origin: u32,
    pub message: Vec<u8>,
}

impl RecipientInstruction {
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}
