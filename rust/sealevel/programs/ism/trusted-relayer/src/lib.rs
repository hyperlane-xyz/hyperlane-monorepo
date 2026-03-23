pub mod processor;

use account_utils::{AccountData, DiscriminatorData, SizedData, PROGRAM_INSTRUCTION_DISCRIMINATOR};
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

// ---- PDA seeds ----

/// PDA seeds for the trusted relayer data account.
#[macro_export]
macro_rules! trusted_relayer_pda_seeds {
    () => {{
        &[b"trusted_relayer_ism", b"-", b"trusted_relayer"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"trusted_relayer_ism",
            b"-",
            b"trusted_relayer",
            &[$bump_seed],
        ]
    }};
}

// ---- Account data types ----

pub type TrustedRelayerAccount = AccountData<TrustedRelayerData>;

#[derive(BorshSerialize, BorshDeserialize, Debug, Default, PartialEq, Clone, Copy)]
pub struct TrustedRelayerData {
    pub bump_seed: u8,
    pub relayer: Pubkey,
}

impl SizedData for TrustedRelayerData {
    fn size(&self) -> usize {
        // bump_seed (1) + Pubkey (32)
        1 + 32
    }
}

// ---- Instructions ----

#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program with an immutable trusted relayer.
    /// Can only be called once.
    ///
    /// Accounts:
    /// 0. `[signer]` Payer.
    /// 1. `[writable]` Trusted relayer PDA.
    /// 2. `[executable]` System program.
    Initialize(Pubkey),
}

impl DiscriminatorData for Instruction {
    const DISCRIMINATOR: [u8; Self::DISCRIMINATOR_LENGTH] = PROGRAM_INSTRUCTION_DISCRIMINATOR;
}

// ---- Errors ----

#[derive(Debug, PartialEq)]
pub enum Error {
    AccountOutOfOrder,
    AlreadyInitialized,
    AccountNotInitialized,
    ProgramIdNotOwner,
    RelayerMismatch,
    RelayerNotSigner,
}

impl From<Error> for ProgramError {
    fn from(err: Error) -> Self {
        ProgramError::Custom(err as u32)
    }
}
