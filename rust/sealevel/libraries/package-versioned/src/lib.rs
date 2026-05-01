use serializable_account_meta::SimulationReturnData;
use solana_program::{
    instruction::Instruction, program::set_return_data, program_error::ProgramError, pubkey::Pubkey,
};

/// Single source of truth for all Hyperlane SVM program versions.
/// Compiled into each program's binary — atomic on upgrade, no migration step.
pub const PACKAGE_VERSION: &str = "1.0.0";

/// Trait for programs that expose their version.
/// Programs implement with empty impl block to get the default.
pub trait PackageVersioned {
    fn package_version() -> &'static str {
        PACKAGE_VERSION
    }
}

/// 8-byte discriminator for the `GetProgramVersion` instruction.
/// First 8 bytes of `sha256(b"hyperlane:get-program-version")`.
/// This is independent of any program's instruction enum, allowing
/// universal version queries across all Hyperlane SVM programs.
pub const GET_PROGRAM_VERSION_DISCRIMINATOR: [u8; 8] = [150, 230, 176, 162, 236, 96, 183, 171];

/// Attempts to decode a `GetProgramVersion` instruction from raw instruction data.
/// Returns true if the data matches the discriminator, false otherwise.
pub fn is_get_program_version(instruction_data: &[u8]) -> bool {
    instruction_data.len() == GET_PROGRAM_VERSION_DISCRIMINATOR.len()
        && instruction_data == GET_PROGRAM_VERSION_DISCRIMINATOR
}

/// Builds the instruction data for a `GetProgramVersion` call.
pub fn get_program_version_instruction_data() -> Vec<u8> {
    GET_PROGRAM_VERSION_DISCRIMINATOR.to_vec()
}

/// Builds a `GetProgramVersion` instruction. No accounts required.
pub fn get_program_version_instruction(program_id: Pubkey) -> Instruction {
    Instruction {
        program_id,
        data: get_program_version_instruction_data(),
        accounts: vec![],
    }
}

/// Shared handler for the `GetProgramVersion` instruction.
/// Writes the version string as return data wrapped in SimulationReturnData.
pub fn process_get_program_version<T: PackageVersioned>() -> Result<(), ProgramError> {
    let version = T::package_version();
    set_return_data(
        &borsh::to_vec(&SimulationReturnData::new(version.to_string()))
            .map_err(|_| ProgramError::BorshIoError)?,
    );
    Ok(())
}
