//! API for Hyperlane Sealevel Mailbox smart contract.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;
use solana_program::{
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{mailbox_inbox_pda_seeds, mailbox_outbox_pda_seeds};

/// Hyperlane mailbox protocol version.
pub const VERSION: u8 = 0;

/// Maximum bytes per message = 2 KiB (somewhat arbitrarily set to begin).
pub const MAX_MESSAGE_BODY_BYTES: usize = 2 * 2_usize.pow(10);

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init(Init),
    InboxProcess(InboxProcess),
    InboxSetDefaultIsm(Pubkey),
    InboxGetRecipientIsm(Pubkey),
    OutboxDispatch(OutboxDispatch),
    OutboxGetCount,
    OutboxGetLatestCheckpoint,
    OutboxGetRoot,
    GetOwner,
    TransferOwnership(Option<Pubkey>),
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
    pub default_ism: Pubkey,
}

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct OutboxDispatch {
    // The sender may not necessarily be the transaction payer so specify separately.
    pub sender: Pubkey,
    pub destination_domain: u32,
    pub recipient: H256,
    pub message_body: Vec<u8>,
}

// Note: maximum transaction size is ~1kB, so will need to use accounts for large messages.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InboxProcess {
    pub metadata: Vec<u8>, // Encoded Multi-Signature ISM data, or similar.
    pub message: Vec<u8>,  // Encoded HyperlaneMessage
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
