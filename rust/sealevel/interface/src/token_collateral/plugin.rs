//! A plugin for the Hyperlane token program that escrows SPL tokens as collateral.

use account_utils::SizedData;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Seeds relating to the PDA account that acts both as the mint
/// *and* the mint authority.
#[macro_export]
macro_rules! hyperlane_token_escrow_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"escrow"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"escrow", &[$bump_seed]]
    }};
}

/// A plugin for the Hyperlane token program that escrows SPL
/// tokens when transferring out to a remote chain, and pays them
/// out when transferring in from a remote chain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct CollateralPlugin {
    /// The SPL token program, i.e. either SPL token program or the 2022 version.
    pub spl_token_program: Pubkey,
    /// The mint.
    pub mint: Pubkey,
    /// The escrow PDA account.
    pub escrow: Pubkey,
    /// The escrow PDA bump seed.
    pub escrow_bump: u8,
    /// The ATA payer PDA bump seed.
    pub ata_payer_bump: u8,
}

impl SizedData for CollateralPlugin {
    fn size(&self) -> usize {
        // spl_token_program
        32
            // mint
            + 32
            // escrow
            + 32
            // escrow_bump
            + std::mem::size_of::<u8>()
            // ata_payer_bump
            + std::mem::size_of::<u8>()
    }
}
