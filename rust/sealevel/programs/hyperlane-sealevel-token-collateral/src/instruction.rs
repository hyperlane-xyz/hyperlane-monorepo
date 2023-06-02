//! Instructions.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_token_lib::instruction::{Init, TransferRemote};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

/// Instructions for this program.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initialize the program.
    Init(Init),
    /// Transfer tokens to a remote recipient.
    TransferRemote(TransferRemote),
    /// Enroll a remote router. Only owner.
    EnrollRemoteRouter(RemoteRouterConfig),
    /// Enroll multiple remote routers. Only owner.
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
    /// Set the interchain security module. Only owner.
    SetInterchainSecurityModule(Option<Pubkey>),
    /// Transfer ownership of the program. Only owner.
    TransferOwnership(Option<Pubkey>),
}

impl Instruction {
    /// Deserialize an instruction from a byte slice.
    pub fn from_instruction_data(data: &[u8]) -> Result<Self, ProgramError> {
        Self::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)
    }

    /// Serialize an instruction into a byte vector.
    pub fn into_instruction_data(self) -> Result<Vec<u8>, ProgramError> {
        self.try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))
    }
}
