use hyperlane_core::{Hasher, Signable, H160};
use solana_program::{
    keccak,
    program_error::ProgramError,
    secp256k1_recover::{secp256k1_recover, Secp256k1RecoverError},
};

use crate::error::Error;

pub struct EcdsaSignature {
    pub serialized_rs: [u8; 64],
    pub recovery_id: u8,
}

impl EcdsaSignature {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() != 65 {
            return Err(ProgramError::InvalidArgument);
        }

        let mut serialized_rs = [0u8; 64];
        serialized_rs.copy_from_slice(&bytes[..64]);

        let mut recovery_id = bytes[64];
        if recovery_id == 27 || recovery_id == 28 {
            recovery_id -= 27;
        }

        // Recovery ID must be 0 or 1
        if recovery_id > 1 {
            return Err(Error::InvalidSignatureRecoveryId.into());
        }

        Ok(Self {
            serialized_rs,
            recovery_id,
        })
    }
}

fn secp256k1_recover_ethereum_address(
    hash: &[u8],
    recovery_id: u8,
    signature: &[u8],
) -> Result<H160, Secp256k1RecoverError> {
    let public_key = secp256k1_recover(hash, recovery_id, signature)?;

    let public_key_hash = {
        let mut hasher = keccak::Hasher::default();
        hasher.hash(&public_key.to_bytes()[..]);
        &hasher.result().to_bytes()[12..]
    };

    Ok(H160::from_slice(public_key_hash))
}

pub struct MultisigIsm<T: Signable<KeccakHasher>> {
    signed_data: T,
    signatures: Vec<EcdsaSignature>,
    validators: Vec<H160>,
    threshold: u8,
}

pub enum MultisigIsmError {
    InvalidSignature,
    ThresholdNotMet,
}

impl Into<Error> for MultisigIsmError {
    fn into(self) -> Error {
        match self {
            MultisigIsmError::InvalidSignature => Error::InvalidSignature,
            MultisigIsmError::ThresholdNotMet => Error::ThresholdNotMet,
        }
    }
}

impl<T: Signable<KeccakHasher>> MultisigIsm<T> {
    pub fn new(
        signed_data: T,
        signatures: Vec<EcdsaSignature>,
        validators: Vec<H160>,
        threshold: u8,
    ) -> Self {
        Self {
            signed_data,
            signatures,
            validators,
            threshold,
        }
    }

    pub fn verify(&self) -> Result<(), MultisigIsmError> {
        let signed_digest = self.signed_data.eth_signed_message_hash();
        let signed_digest_bytes = signed_digest.as_bytes();

        let validator_count = self.validators.len();
        let mut validator_index = 0;

        // Assumes that signatures are ordered by validator
        for i in 0..self.threshold {
            let signature = &self.signatures[i as usize];
            let signer = secp256k1_recover_ethereum_address(
                signed_digest_bytes,
                signature.recovery_id,
                signature.serialized_rs.as_slice(),
            )
            .map_err(|_| MultisigIsmError::InvalidSignature)?;

            while validator_index < validator_count && signer != self.validators[validator_index] {
                validator_index += 1;
            }

            if validator_index >= validator_count {
                return Err(MultisigIsmError::ThresholdNotMet);
            }

            validator_index += 1;
        }

        Ok(())
    }
}

#[derive(Default)]
pub struct KeccakHasher(keccak::Hasher);

impl Hasher for KeccakHasher {
    fn hash(mut self, payload: &[u8]) -> [u8; 32] {
        self.0.hash(payload);
        self.0.result().to_bytes()
    }
}
