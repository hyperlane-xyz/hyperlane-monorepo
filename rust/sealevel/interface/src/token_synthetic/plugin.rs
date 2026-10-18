//! A plugin for the Hyperlane token program that mints synthetic
//! tokens upon receiving a transfer from a remote chain, and burns
//! synthetic tokens when transferring out to a remote chain.

use account_utils::SizedData;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

/// Seeds relating to the PDA account that acts both as the mint
/// *and* the mint authority.
#[macro_export]
macro_rules! hyperlane_token_mint_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"mint"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"mint", &[$bump_seed]]
    }};
}

/// A plugin for the Hyperlane token program that mints synthetic
/// tokens upon receiving a transfer from a remote chain, and burns
/// synthetic tokens when transferring out to a remote chain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct SyntheticPlugin {
    /// The mint / mint authority PDA account.
    pub mint: Pubkey,
    /// The bump seed for the mint / mint authority PDA account.
    pub mint_bump: u8,
    /// The bump seed for the ATA payer PDA account.
    pub ata_payer_bump: u8,
}

impl SizedData for SyntheticPlugin {
    fn size(&self) -> usize {
        // mint
        32 +
        // mint_bump
        std::mem::size_of::<u8>() +
        // ata_payer_bump
        std::mem::size_of::<u8>()
    }
}
