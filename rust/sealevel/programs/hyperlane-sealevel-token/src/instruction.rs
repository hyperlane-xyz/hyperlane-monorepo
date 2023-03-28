//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init(Init),
    TransferRemote(TransferRemote),
    TransferFromRemote(TransferFromRemote), // aka "handle" in solidity contract. Used as mailbox recipient.

    // FIXME These variants probably shouldn't exist?
    TransferFromSender(TransferFromSender),
    TransferTo(TransferTo),
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

// note don't need local domain bc that's handled by mailbox internally
/// Initializes the Hyperlane router, ERC20 metadata, and mints initial supply to deployer.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct Init {
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The address of the interchain gas paymaster contract.
    pub interchain_gas_paymaster: Pubkey,
    /// The initial supply of the token.
    pub total_supply: U256,
    // TODO use datatype to enforce character set? We don't want to allow "-" because it is used
    // in pda seeds as separator, right?
    /// The name of the token.
    pub name: String,
    /// The symbol of the token.
    pub symbol: String,
}

/// Transfers `amount_or_id` token to `recipient` on `destination` domain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferRemote {
    destination: u32,
    recipient: H256,
    amount_or_id: U256,
}

/// Mints tokens to recipient when router receives transfer message.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferFromRemote {
    origin: u32,
    // sender: H256, // FIXME?
    message: Vec<u8>,
}

/// Burns `_amount` of token from `msg.sender` balance.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferFromSender {
    pub amount: U256,
    // The sender may not necessarily be the transaction payer so specify separately.
    // pub sender: Pubkey, // Already in list of accounts for instruction
}

/// Mints `_amount` of token to `_recipient` balance.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct TransferTo {
    // pub recipient: Pubkey, // already in list of accounts for instruction
    pub amount: U256,
    // pub calldata: Vec<u8>, // no metadata FIXME?
}
