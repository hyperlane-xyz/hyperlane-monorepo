//! A plugin for the Hyperlane token program that transfers native
//! tokens in from a sender when sending to a remote chain, and transfers
//! native tokens out to recipients when receiving from a remote chain.

use account_utils::SizedData;
use borsh::{BorshDeserialize, BorshSerialize};

/// Seeds relating to the PDA account that holds native collateral.
#[macro_export]
macro_rules! hyperlane_token_native_collateral_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"native_collateral"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            b"native_collateral",
            &[$bump_seed],
        ]
    }};
}

/// A plugin for the Hyperlane token program that transfers native
/// tokens in from a sender when sending to a remote chain, and transfers
/// native tokens out to recipients when receiving from a remote chain.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct NativePlugin {
    /// The bump seed for the native collateral PDA account.
    pub native_collateral_bump: u8,
}

impl SizedData for NativePlugin {
    fn size(&self) -> usize {
        // native_collateral_bump
        std::mem::size_of::<u8>()
    }
}
