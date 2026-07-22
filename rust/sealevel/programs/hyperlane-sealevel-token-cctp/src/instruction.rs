//! This program's own instructions, beyond what `hyperlane-sealevel-token-lib`'s
//! generic `Instruction` enum and the shared `MessageRecipientInstruction`/
//! `InterchainSecurityModuleInstruction` interfaces already provide.
//!
//! Dispatched via a fixed 8-byte discriminator (same convention as
//! `InterchainSecurityModuleInstruction`), checked before falling through to
//! the generic library's plain-Borsh `Instruction` enum — same layering
//! `hyperlane-sealevel-token-collateral`'s processor already uses for
//! `MessageRecipientInstruction`.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::program_error::ProgramError;

/// `sha256("hyperlane-token-cctp:set-remote-config")[..8]`.
pub const SET_REMOTE_CONFIG_DISCRIMINATOR: [u8; 8] =
    [0x94, 0x96, 0x95, 0x24, 0xfe, 0x6a, 0x7b, 0x2f];

/// `sha256("hyperlane-token-cctp:stage-verify-metadata")[..8]`.
pub const STAGE_VERIFY_METADATA_DISCRIMINATOR: [u8; 8] =
    [0x51, 0xe9, 0x3c, 0x92, 0x96, 0x84, 0xb6, 0xdf];

#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct SetRemoteConfig {
    pub destination_domain: u32,
    pub circle_domain: u32,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
}

/// Args for [`CctpInstruction::StageVerifyMetadata`] — see its variant doc.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct StageVerifyMetadata {
    /// The Hyperlane message id this payload is for — keys the staging PDA.
    /// Not derived from `message` below: that's Circle's own CCTP message,
    /// a distinct artifact from the Hyperlane message being verified.
    pub message_id: [u8; 32],
    /// Circle's raw CCTP v2 message bytes (header + `BurnMessage` body).
    pub message: Vec<u8>,
    /// Circle's off-chain attestation over `message`.
    pub attestation: Vec<u8>,
}

/// This program's custom instruction namespace.
#[derive(Debug, PartialEq)]
pub enum CctpInstruction {
    SetRemoteConfig(SetRemoteConfig),
    /// Writes `{message, attestation}` into a PDA keyed by the CCTP nonce
    /// parsed out of `message`, so the ISM's `Verify()` instruction can read
    /// them from account data instead of embedding them inline — the
    /// combined size of the raw Hyperlane message, this payload, and the
    /// ~23 accounts `Verify()` needs for Circle's CPI exceeds Solana's
    /// transaction size limit otherwise. Permissionless and idempotent:
    /// content is self-validating (Circle's attestation is checked by
    /// `Verify()`'s CPI into `receive_message`, so staging garbage here
    /// just fails that check later, and the PDA's nonce-derived address
    /// can't be pre-empted before the real nonce exists).
    StageVerifyMetadata(StageVerifyMetadata),
}

impl CctpInstruction {
    pub fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < 8 {
            return Err(ProgramError::InvalidInstructionData);
        }
        let (discriminator, rest) = data.split_at(8);
        match discriminator {
            d if d == SET_REMOTE_CONFIG_DISCRIMINATOR => {
                let config = SetRemoteConfig::try_from_slice(rest)
                    .map_err(|_| ProgramError::InvalidInstructionData)?;
                Ok(Self::SetRemoteConfig(config))
            }
            d if d == STAGE_VERIFY_METADATA_DISCRIMINATOR => {
                let params = StageVerifyMetadata::try_from_slice(rest)
                    .map_err(|_| ProgramError::InvalidInstructionData)?;
                Ok(Self::StageVerifyMetadata(params))
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = Vec::new();
        match self {
            Self::SetRemoteConfig(config) => {
                buf.extend_from_slice(&SET_REMOTE_CONFIG_DISCRIMINATOR);
                buf.extend_from_slice(
                    &borsh::to_vec(config).map_err(|_| ProgramError::BorshIoError)?,
                );
            }
            Self::StageVerifyMetadata(params) => {
                buf.extend_from_slice(&STAGE_VERIFY_METADATA_DISCRIMINATOR);
                buf.extend_from_slice(
                    &borsh::to_vec(params).map_err(|_| ProgramError::BorshIoError)?,
                );
            }
        }
        Ok(buf)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_set_remote_config_discriminator_matches_sha256() {
        let computed = solana_program::hash::hash(b"hyperlane-token-cctp:set-remote-config");
        assert_eq!(
            &computed.to_bytes()[..8],
            &SET_REMOTE_CONFIG_DISCRIMINATOR[..]
        );
    }

    #[test]
    fn test_set_remote_config_roundtrip() {
        let ixn = CctpInstruction::SetRemoteConfig(SetRemoteConfig {
            destination_domain: 1,
            circle_domain: 0,
            max_fee: 100,
            min_finality_threshold: 2000,
        });
        let encoded = ixn.encode().unwrap();
        let decoded = CctpInstruction::decode(&encoded).unwrap();
        assert_eq!(ixn, decoded);
    }

    #[test]
    fn test_stage_verify_metadata_discriminator_matches_sha256() {
        let computed = solana_program::hash::hash(b"hyperlane-token-cctp:stage-verify-metadata");
        assert_eq!(
            &computed.to_bytes()[..8],
            &STAGE_VERIFY_METADATA_DISCRIMINATOR[..]
        );
    }

    #[test]
    fn test_stage_verify_metadata_roundtrip() {
        let ixn = CctpInstruction::StageVerifyMetadata(StageVerifyMetadata {
            message_id: [0x77; 32],
            message: vec![0xAA; 376],
            attestation: vec![0xBB; 130],
        });
        let encoded = ixn.encode().unwrap();
        let decoded = CctpInstruction::decode(&encoded).unwrap();
        assert_eq!(ixn, decoded);
    }

    #[test]
    fn test_decode_rejects_unknown_discriminator() {
        let mut data = vec![0xFFu8; 8];
        data.extend_from_slice(
            &borsh::to_vec(&SetRemoteConfig {
                destination_domain: 1,
                circle_domain: 0,
                max_fee: 0,
                min_finality_threshold: 2000,
            })
            .unwrap(),
        );
        assert!(CctpInstruction::decode(&data).is_err());
    }
}
