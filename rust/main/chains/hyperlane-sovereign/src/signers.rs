use std::env;

use bech32::{Bech32m, Hrp};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use hyperlane_core::{ChainCommunicationError, ChainResult, H256};
use tokio::fs;
use tracing::warn;

/// Length of the sovereign address in bytes
pub const SOV_ADDRESS_LENGTH: usize = 28;
/// Amount of leading zeros padding in hex address representation.
pub const SOV_HEX_ADDRESS_LEADING_ZEROS: usize = 4;

/// Signer for Sovereign chain.
#[derive(Clone, Debug)]
pub struct Signer {
    /// Private key
    private_key: SigningKey,
    /// Precomputed address, as the operation is fallible.
    address: String,
}

impl Signer {
    /// Create a new Sovereign signer.
    pub fn new(private_key: &H256) -> ChainResult<Self> {
        let private_key = private_key.as_fixed_bytes().into();
        let address = address_from_sk(&private_key)?;
        Ok(Signer {
            address,
            private_key,
        })
    }

    /// Get the key for sovereign signer if it was provided using `TOKEN_KEY_FILE` env var.
    ///
    /// This is kept for backward compatibility of old setups relying on this way of provisioning.
    /// Should not be relied on otherwise, and `--chains.<sov-rollup-name>.signer.key=<hex>` should be used instead
    // TODO: delete this after sov side audit is completed / upstream to hyperlane-xyz happens
    pub async fn get_key_override() -> ChainResult<Option<H256>> {
        const KEY_FILE_VAR: &str = "TOKEN_KEY_FILE";

        let Ok(key_file) = env::var(KEY_FILE_VAR) else {
            return Ok(None);
        };

        warn!("Getting sovereign key from {key_file}; this behaviour is deprecated and will be removed");

        let data = fs::read_to_string(&key_file).await.map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to read file at {key_file}: {e:?}"
            ))
        })?;
        let outer_value: serde_json::Value = serde_json::from_str(&data)?;
        let inner_value = outer_value["private_key"]["key_pair"].clone();
        let bytes: [u8; 32] = serde_json::from_value(inner_value)?;

        Ok(Some(H256(bytes)))
    }

    /// Produce signature for the hash of the input
    pub fn sign(&self, input: impl AsRef<[u8]>) -> Signature {
        self.private_key.sign(input.as_ref())
    }

    /// Get the public key
    pub fn public_key(&self) -> &VerifyingKey {
        self.private_key.as_ref()
    }

    /// Get the address as `bech32` string
    pub fn address(&self) -> &str {
        &self.address
    }

    /// Get the address as [`H256`] padded with 0's from the left
    pub fn h256_address(&self) -> H256 {
        let mut h256 = H256::zero();
        h256[SOV_HEX_ADDRESS_LEADING_ZEROS..]
            .copy_from_slice(&self.public_key().to_bytes()[..SOV_ADDRESS_LENGTH]);
        h256
    }
}

fn address_from_sk(private_key: &SigningKey) -> ChainResult<String> {
    // Sov address uses first 28 bytes of the public key
    // <https://github.com/Sovereign-Labs/sovereign-sdk-wip/blob/fdad6aef490656ce4ad6c93f486569acb71d11eb/crates/module-system/sov-modules-api/src/common/address.rs#L411-L415>
    // <https://github.com/Sovereign-Labs/sovereign-sdk-wip/blob/fdad6aef490656ce4ad6c93f486569acb71d11eb/crates/module-system/sov-modules-api/src/common/address.rs#L365-L369>
    let hrp = Hrp::parse("sov").expect("valid hrp");
    let public_key = private_key.verifying_key();
    let address = bech32::encode::<Bech32m>(hrp, &public_key.as_bytes()[..SOV_ADDRESS_LENGTH])
        .map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Encoding public key to bech32 failed: {e}"
            ))
        })?;

    Ok(address)
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_address_from_h256() {
        // values from <https://github.com/Sovereign-Labs/sov-rollup-starter-wip/blob/94ce661edb1dcc338bc4b7232b8fe8632e7540c5/test-data/keys/token_deployer_private_key.json>
        let private_key = H256([
            117, 251, 248, 217, 135, 70, 194, 105, 46, 80, 41, 66, 185, 56, 200, 35, 121, 253, 9,
            234, 159, 91, 96, 212, 211, 158, 135, 225, 180, 36, 104, 253,
        ]);
        let signer = Signer::new(&private_key).unwrap();

        assert_eq!(
            "sov1lzkjgdaz08su3yevqu6ceywufl35se9f33kztu5cu2spja5hyyf",
            signer.address()
        );
        assert_eq!(
            "0x00000000f8ad2437a279e1c8932c07358c91dc4fe34864a98c6c25f298e2a019",
            format!("{:?}", signer.h256_address()),
        );
    }
}
