use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H160;
use solana_program::{program_error::ProgramError, pubkey::Pubkey};
use spl_discriminator::ArrayDiscriminator as Discriminator;

/// The metadata format a message's ISM requires the relayer to supply.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub enum MetadataSpec {
    /// No metadata needed (e.g. TrustedRelayer, Test, Pausable, RateLimited).
    Null,
    /// Standard secp256k1 multisig over the message ID.
    MultisigMessageId {
        validators: Vec<H160>,
        threshold: u8,
    },
    /// m-of-n aggregation; each sub-spec maps to one sub-ISM in order.
    Aggregation {
        threshold: u8,
        sub_specs: Vec<MetadataSpec>,
    },
}

/// Return value of `VerifyMetadataSpec`, wrapped in `SimulationReturnData<MetadataSpecResult>`.
///
/// When `spec` is `None` the ISM could not yet determine the full spec because
/// some accounts were missing.  The relayer must add the pubkeys in `accounts`
/// and re-simulate.  When `spec` is `Some` the result has converged and
/// `accounts` is empty.
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq)]
pub struct MetadataSpecResult {
    pub spec: Option<MetadataSpec>,
    pub accounts: Vec<Pubkey>,
}

/// Instructions that a Hyperlane interchain security module is expected to process.
/// The first 8 bytes of the encoded instruction is a discriminator that
/// allows programs to implement the required interface.
#[derive(Clone, Eq, PartialEq, Debug)]
pub enum InterchainSecurityModuleInstruction {
    /// Gets the type of ISM.
    Type,
    /// Verifies a message.
    Verify(VerifyInstruction),
    /// Gets the list of AccountMetas required for the `Verify` instruction.
    /// The only account expected to be passed into this instruction is the
    /// read-only PDA relating to the program ID and the seeds `VERIFY_ACCOUNT_METAS_PDA_SEEDS`
    VerifyAccountMetas(VerifyInstruction),
    /// Returns a [`MetadataSpecResult`] for the given message as set_return_data,
    /// wrapped in `SimulationReturnData<MetadataSpecResult>`.
    ///
    /// Account 0 must always be the ISM's storage PDA (derived from
    /// `VERIFY_ACCOUNT_METAS_PDA_SEEDS`).  Additional accounts vary by ISM type.
    /// If the result's `spec` is `None`, re-simulate with the returned accounts appended.
    VerifyMetadataSpec(VerifyMetadataSpecInstruction),
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:type"])`
const TYPE_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [105, 97, 97, 88, 63, 124, 106, 18];
const TYPE_DISCRIMINATOR_SLICE: &[u8] = &TYPE_DISCRIMINATOR;

#[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct VerifyInstruction {
    pub metadata: Vec<u8>,
    pub message: Vec<u8>,
}

impl VerifyInstruction {
    pub fn new(metadata: Vec<u8>, message: Vec<u8>) -> Self {
        Self { metadata, message }
    }
}

#[derive(Eq, PartialEq, BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct VerifyMetadataSpecInstruction {
    pub message: Vec<u8>,
}

impl VerifyMetadataSpecInstruction {
    pub fn new(message: Vec<u8>) -> Self {
        Self { message }
    }
}

/// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:verify"])`
const VERIFY_DISCRIMINATOR: [u8; Discriminator::LENGTH] = [243, 53, 214, 0, 208, 18, 231, 67];
const VERIFY_DISCRIMINATOR_SLICE: &[u8] = &VERIFY_DISCRIMINATOR;

/// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:verify-account-metas"])`
const VERIFY_ACCOUNT_METAS_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [200, 65, 157, 12, 89, 255, 131, 216];
const VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE: &[u8] = &VERIFY_ACCOUNT_METAS_DISCRIMINATOR;

/// First 8 bytes of `hash::hashv(&[b"hyperlane-interchain-security-module:verify-metadata-spec"])`
const VERIFY_METADATA_SPEC_DISCRIMINATOR: [u8; Discriminator::LENGTH] =
    [49, 24, 22, 218, 134, 132, 63, 155];
const VERIFY_METADATA_SPEC_DISCRIMINATOR_SLICE: &[u8] = &VERIFY_METADATA_SPEC_DISCRIMINATOR;

/// Seeds for the PDA that's expected to be passed into the `VerifyAccountMetas`
/// instruction.
pub const VERIFY_ACCOUNT_METAS_PDA_SEEDS: &[&[u8]] =
    &[b"hyperlane_ism", b"-", b"verify", b"-", b"account_metas"];

impl InterchainSecurityModuleInstruction {
    pub fn encode(&self) -> Result<Vec<u8>, ProgramError> {
        let mut buf = vec![];
        match self {
            InterchainSecurityModuleInstruction::Type => {
                buf.extend_from_slice(TYPE_DISCRIMINATOR_SLICE);
            }
            InterchainSecurityModuleInstruction::Verify(instruction) => {
                buf.extend_from_slice(VERIFY_DISCRIMINATOR_SLICE);
                buf.extend_from_slice(
                    &borsh::to_vec(&instruction).map_err(|_| ProgramError::BorshIoError)?[..],
                );
            }
            InterchainSecurityModuleInstruction::VerifyAccountMetas(instruction) => {
                buf.extend_from_slice(VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE);
                buf.extend_from_slice(
                    &borsh::to_vec(&instruction).map_err(|_| ProgramError::BorshIoError)?[..],
                );
            }
            InterchainSecurityModuleInstruction::VerifyMetadataSpec(instruction) => {
                buf.extend_from_slice(VERIFY_METADATA_SPEC_DISCRIMINATOR_SLICE);
                buf.extend_from_slice(
                    &borsh::to_vec(&instruction).map_err(|_| ProgramError::BorshIoError)?[..],
                );
            }
        }

        Ok(buf)
    }

    pub fn decode(buf: &[u8]) -> Result<Self, ProgramError> {
        if buf.len() < Discriminator::LENGTH {
            return Err(ProgramError::InvalidInstructionData);
        }
        let (discriminator, rest) = buf.split_at(Discriminator::LENGTH);
        match discriminator {
            TYPE_DISCRIMINATOR_SLICE => Ok(Self::Type),
            VERIFY_DISCRIMINATOR_SLICE => {
                let instruction = VerifyInstruction::try_from_slice(rest)
                    .map_err(|_| ProgramError::BorshIoError)?;
                Ok(Self::Verify(instruction))
            }
            VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE => {
                let instruction = VerifyInstruction::try_from_slice(rest)
                    .map_err(|_| ProgramError::BorshIoError)?;
                Ok(Self::VerifyAccountMetas(instruction))
            }
            VERIFY_METADATA_SPEC_DISCRIMINATOR_SLICE => {
                let instruction = VerifyMetadataSpecInstruction::try_from_slice(rest)
                    .map_err(|_| ProgramError::BorshIoError)?;
                Ok(Self::VerifyMetadataSpec(instruction))
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use solana_program::hash::hashv;

    #[test]
    fn test_discriminator_slices() {
        assert_eq!(
            &hashv(&[b"hyperlane-interchain-security-module:type"]).to_bytes()
                [..Discriminator::LENGTH],
            TYPE_DISCRIMINATOR_SLICE,
        );
        assert_eq!(
            &hashv(&[b"hyperlane-interchain-security-module:verify"]).to_bytes()
                [..Discriminator::LENGTH],
            VERIFY_DISCRIMINATOR_SLICE,
        );
        assert_eq!(
            &hashv(&[b"hyperlane-interchain-security-module:verify-account-metas"]).to_bytes()
                [..Discriminator::LENGTH],
            VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );
        assert_eq!(
            &hashv(&[b"hyperlane-interchain-security-module:verify-metadata-spec"]).to_bytes()
                [..Discriminator::LENGTH],
            VERIFY_METADATA_SPEC_DISCRIMINATOR_SLICE,
        );
    }

    #[test]
    fn test_encode_decode_type_instruction() {
        let instruction = InterchainSecurityModuleInstruction::Type;
        let encoded = instruction.encode().unwrap();
        assert_eq!(&encoded[..Discriminator::LENGTH], TYPE_DISCRIMINATOR_SLICE);
        let decoded = InterchainSecurityModuleInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_verify_instruction() {
        let instruction = InterchainSecurityModuleInstruction::Verify(VerifyInstruction::new(
            vec![5, 4, 3, 2, 1],
            vec![1, 2, 3, 4, 5],
        ));
        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VERIFY_DISCRIMINATOR_SLICE
        );
        let decoded = InterchainSecurityModuleInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_verify_account_metas_instruction() {
        let instruction = InterchainSecurityModuleInstruction::VerifyAccountMetas(
            VerifyInstruction::new(vec![5, 4, 3, 2, 1], vec![1, 2, 3, 4, 5]),
        );
        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VERIFY_ACCOUNT_METAS_DISCRIMINATOR_SLICE,
        );
        let decoded = InterchainSecurityModuleInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }

    #[test]
    fn test_encode_decode_verify_metadata_spec_instruction() {
        let instruction = InterchainSecurityModuleInstruction::VerifyMetadataSpec(
            VerifyMetadataSpecInstruction::new(vec![1, 2, 3, 4, 5]),
        );
        let encoded = instruction.encode().unwrap();
        assert_eq!(
            &encoded[..Discriminator::LENGTH],
            VERIFY_METADATA_SPEC_DISCRIMINATOR_SLICE,
        );
        let decoded = InterchainSecurityModuleInstruction::decode(&encoded).unwrap();
        assert_eq!(instruction, decoded);
    }
}
