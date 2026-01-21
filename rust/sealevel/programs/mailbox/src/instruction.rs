//! Instructions for the Hyperlane Sealevel Mailbox program.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use shank::{ShankInstruction, ShankType};
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds, protocol_fee::ProtocolFee};

/// The current message version.
pub const VERSION: u8 = 3;

/// Instructions supported by the Mailbox program.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, ShankInstruction)]
pub enum Instruction {
    /// Initializes the program.
    #[account(0, name = "system_program", desc = "System program")]
    #[account(1, writable, signer, name = "payer", desc = "Payer and owner")]
    #[account(2, writable, name = "inbox", desc = "Inbox PDA")]
    #[account(3, writable, name = "outbox", desc = "Outbox PDA")]
    Init(Init),

    /// Processes a message.
    #[account(0, signer, name = "payer", desc = "Payer account")]
    #[account(1, name = "system_program", desc = "System program")]
    #[account(2, writable, name = "inbox", desc = "Inbox PDA")]
    #[account(3, name = "process_authority", desc = "Process authority PDA")]
    #[account(
        4,
        writable,
        name = "processed_message",
        desc = "Processed message PDA"
    )]
    InboxProcess(InboxProcess),

    /// Sets the default ISM.
    #[account(0, writable, name = "inbox", desc = "Inbox PDA")]
    #[account(1, name = "outbox", desc = "Outbox PDA")]
    #[account(2, writable, signer, name = "owner", desc = "Mailbox owner")]
    InboxSetDefaultIsm(Pubkey),

    /// Gets the recipient's ISM.
    #[account(0, name = "inbox", desc = "Inbox PDA")]
    #[account(1, name = "recipient", desc = "Recipient program")]
    InboxGetRecipientIsm(Pubkey),

    /// Dispatches a message.
    #[account(0, writable, name = "outbox", desc = "Outbox PDA")]
    #[account(1, signer, name = "sender_signer", desc = "Message sender signer")]
    #[account(2, name = "system_program", desc = "System program")]
    #[account(3, name = "spl_noop", desc = "SPL Noop program")]
    #[account(4, signer, name = "payer", desc = "Payer")]
    #[account(
        5,
        signer,
        name = "unique_message_account",
        desc = "Unique message account"
    )]
    #[account(
        6,
        writable,
        name = "dispatched_message",
        desc = "Dispatched message PDA"
    )]
    OutboxDispatch(OutboxDispatch),

    /// Gets the number of messages that have been dispatched.
    #[account(0, name = "outbox", desc = "Outbox PDA")]
    OutboxGetCount,

    /// Gets the latest checkpoint.
    #[account(0, name = "outbox", desc = "Outbox PDA")]
    OutboxGetLatestCheckpoint,

    /// Gets the root of the dispatched message merkle tree.
    #[account(0, name = "outbox", desc = "Outbox PDA")]
    OutboxGetRoot,

    /// Gets the owner of the Mailbox.
    #[account(0, name = "outbox", desc = "Outbox PDA")]
    GetOwner,

    /// Transfers ownership of the Mailbox.
    #[account(0, writable, name = "outbox", desc = "Outbox PDA")]
    #[account(1, signer, name = "owner", desc = "Current owner")]
    TransferOwnership(Option<Pubkey>),

    /// Transfers accumulated protocol fees to the beneficiary.
    #[account(0, writable, name = "outbox", desc = "Outbox PDA")]
    #[account(1, name = "beneficiary", desc = "Fee beneficiary")]
    ClaimProtocolFees,

    /// Sets the protocol fee configuration.
    #[account(0, writable, name = "outbox", desc = "Outbox PDA")]
    #[account(1, signer, name = "owner", desc = "Current owner")]
    SetProtocolFeeConfig(ProtocolFee),
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
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, ShankType)]
pub struct Init {
    /// The local domain of the Mailbox.
    pub local_domain: u32,
    /// The default ISM.
    pub default_ism: Pubkey,
    /// The maximum protocol fee that can be charged.
    pub max_protocol_fee: u64,
    /// The protocol fee configuration.
    pub protocol_fee: ProtocolFee,
}

/// Instruction data for the OutboxDispatch instruction.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, ShankType)]
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
    #[idl_type("[u8; 32]")]
    pub recipient: H256,
    /// The message body.
    pub message_body: Vec<u8>,
}

/// Instruction data for the InboxProcess instruction.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, ShankType)]
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
    max_protocol_fee: u64,
    protocol_fee: ProtocolFee,
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
            max_protocol_fee,
            protocol_fee,
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

    // 0. `[writeable]` - The Inbox PDA account.
    // 1. `[]` - The Outbox PDA account.
    // 2. `[signer]` - The owner of the Mailbox.
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
