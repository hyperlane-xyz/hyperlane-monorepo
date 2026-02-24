//! Vendored spl-token-2022 instruction builders for extensions not available
//! in our SDK version.
//!
//! This exists because our spl-token-2022 version (0.5.0) doesn't include
//! the MetadataPointer extension instruction builders.

use hyperlane_sealevel_token::spl_token_2022;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

/// Creates an `InitializeMetadataPointer` instruction.
///
/// This must be called AFTER the mint account is created but BEFORE
/// `initialize_mint2` is called.
///
/// Instruction format (from spl-token-2022 source):
/// - Discriminant: [39, 0] (TokenInstruction::MetadataPointerExtension, Initialize)
/// - Data: authority (32 bytes) + metadata_address (32 bytes)
///
/// Uses OptionalNonZeroPubkey encoding: 32 bytes where default/zeroed means None.
pub fn initialize_metadata_pointer(
    mint: &Pubkey,
    authority: Option<Pubkey>,
    metadata_address: Option<Pubkey>,
) -> Instruction {
    // TokenInstruction::MetadataPointerExtension = 39
    // MetadataPointerInstruction::Initialize = 0
    let mut data = vec![39u8, 0u8];

    // OptionalNonZeroPubkey: Pubkey::default() (all zeros) means None
    data.extend_from_slice(&authority.unwrap_or_default().to_bytes());
    data.extend_from_slice(&metadata_address.unwrap_or_default().to_bytes());

    Instruction {
        program_id: spl_token_2022::id(),
        accounts: vec![AccountMeta::new(*mint, false)],
        data,
    }
}
