//! Instructions for the Hyperlane Sealevel Mailbox program.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds};

/// The current message version.
pub const VERSION: u8 = 0;

/// Maximum bytes per message = 2 KiB (somewhat arbitrarily set to begin).
pub const MAX_MESSAGE_BODY_BYTES: usize = 2 * 2_usize.pow(10);

/// Instructions supported by the Mailbox program.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    Init(Init),
    /// Processes a message.
    InboxProcess(InboxProcess),
    /// Sets the default ISM.
    InboxSetDefaultIsm(Pubkey),
    /// Gets the recipient's ISM.
    InboxGetRecipientIsm(Pubkey),
    /// Dispatches a message.
    OutboxDispatch(OutboxDispatch),
    /// Gets the number of messages that have been dispatched.
    OutboxGetCount,
    /// Gets the latest checkpoint.
    OutboxGetLatestCheckpoint,
    /// Gets the root of the dispatched message merkle tree.
    OutboxGetRoot,
    /// Gets the owner of the Mailbox.
    GetOwner,
    /// Transfers ownership of the Mailbox.
    TransferOwnership(Option<Pubkey>),
}

impl Instruction {
    /// Deserializes an instruction from a slice.
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    /// Serializes an instruction into a vector of bytes.
    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}

/// Instruction data for the Init instruction.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    /// The local domain of the Mailbox.
    pub local_domain: u32,
    /// The default ISM.
    pub default_ism: Pubkey,
}

/// Instruction data for the OutboxDispatch instruction.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct OutboxDispatch {
    /// The sender of the message.
    /// This is required and not implied because a program uses a dispatch authority PDA
    /// to sign the CPI on its behalf. Instruction processing logic prevents a program from
    /// specifying any message sender it wants by requiring the relevant dispatch authority
    /// to sign the CPI.
    pub sender: Pubkey,
    /// The destination domain of the message.
    pub destination_domain: u32,
    /// The remote recipient of the message.
    pub recipient: H256,
    /// The message body.
    pub message_body: Vec<u8>,
}

/// Instruction data for the InboxProcess instruction.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InboxProcess {
    /// The metadata required by the ISM to process the message.
    pub metadata: Vec<u8>,
    /// The encoded message.
    pub message: Vec<u8>,
}

/// Creates an Init instruction.
pub fn init_instruction(
    program_id: Pubkey,
    local_domain: u32,
    default_ism: Pubkey,
    payer: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (inbox_account, _inbox_bump) =
        Pubkey::try_find_program_address(mailbox_inbox_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;
    let (outbox_account, _outbox_bump) =
        Pubkey::try_find_program_address(mailbox_outbox_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    let instruction = SolanaInstruction {
        program_id,
        data: Instruction::Init(Init {
            local_domain,
            default_ism,
        })
        .into_instruction_data()?,
        accounts: vec![
            AccountMeta::new(solana_program::system_program::id(), false),
            AccountMeta::new(payer, true),
            AccountMeta::new(inbox_account, false),
            AccountMeta::new(outbox_account, false),
        ],
    };
    Ok(instruction)
}

/// Creates a TransferOwnership instruction.
pub fn transfer_ownership_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    new_owner: Option<Pubkey>,
) -> Result<SolanaInstruction, ProgramError> {
    let (outbox_account, _outbox_bump) =
        Pubkey::try_find_program_address(mailbox_outbox_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    // 0. `[writeable]` The Outbox PDA account.
    // 1. `[signer]` The current owner.
    let instruction = SolanaInstruction {
        program_id,
        data: Instruction::TransferOwnership(new_owner).into_instruction_data()?,
        accounts: vec![
            AccountMeta::new(outbox_account, false),
            AccountMeta::new(owner_payer, true),
        ],
    };
    Ok(instruction)
}

/// Creates an InboxSetDefaultIsm instruction.
pub fn set_default_ism_instruction(
    program_id: Pubkey,
    owner_payer: Pubkey,
    default_ism: Pubkey,
) -> Result<SolanaInstruction, ProgramError> {
    let (inbox_account, _inbox_bump) =
        Pubkey::try_find_program_address(mailbox_inbox_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;
    let (outbox_account, _outbox_bump) =
        Pubkey::try_find_program_address(mailbox_outbox_pda_seeds!(), &program_id)
            .ok_or(ProgramError::InvalidSeeds)?;

    // 0. [writeable] - The Inbox PDA account.
    // 1. [] - The Outbox PDA account.
    // 2. [signer] - The owner of the Mailbox.
    let instruction = SolanaInstruction {
        program_id,
        data: Instruction::InboxSetDefaultIsm(default_ism).into_instruction_data()?,
        accounts: vec![
            AccountMeta::new(inbox_account, false),
            AccountMeta::new_readonly(outbox_account, false),
            AccountMeta::new(owner_payer, true),
        ],
    };
    Ok(instruction)
}
