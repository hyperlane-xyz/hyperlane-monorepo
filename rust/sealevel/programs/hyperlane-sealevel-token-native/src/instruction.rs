//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_connection_client::router::RemoteRouterConfig;
use hyperlane_sealevel_token_lib::instruction::{Init, TransferRemote};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    Init(Init),
    TransferRemote(TransferRemote),
    EnrollRemoteRouter(RemoteRouterConfig),
    EnrollRemoteRouters(Vec<RemoteRouterConfig>),
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
