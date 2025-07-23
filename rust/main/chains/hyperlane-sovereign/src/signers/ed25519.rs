//! Ed25519 based crypto scheme used in sovereign. This is the default one used e.g. in `TestSpec`.

use bech32::{Bech32m, Hrp};
use ed25519_dalek::{Signer as _, SigningKey};
use hyperlane_core::{ChainCommunicationError, ChainResult, H256};

use crate::signers::Crypto;

/// Length of the sovereign address in bytes
pub const SOV_ADDRESS_LENGTH: usize = 28;
/// Amount of leading zeros padding in hex address representation.
pub const SOV_HEX_ADDRESS_LEADING_ZEROS: usize = 4;

/// Signer for Sovereign chain.
#[derive(Clone, Debug)]
pub struct Signer(SigningKey);

impl Signer {
    /// Create a new Sovereign ed25519 signer.
    pub fn new(private_key: &H256) -> ChainResult<Self> {
        let private_key = private_key.as_fixed_bytes().into();
        Ok(Signer(private_key))
    }
}

impl Crypto for Signer {
    fn sign(&self, bytes: impl AsRef<[u8]>) -> ChainResult<Vec<u8>> {
        Ok(self.0.sign(bytes.as_ref()).to_bytes().to_vec())
    }

    fn public_key(&self) -> Vec<u8> {
        self.0.verifying_key().as_bytes().to_vec()
    }

    fn address(&self) -> ChainResult<String> {
        // Sov address uses first 28 bytes of the public key
        // <https://github.com/Sovereign-Labs/sovereign-sdk-wip/blob/fdad6aef490656ce4ad6c93f486569acb71d11eb/crates/module-system/sov-modules-api/src/common/address.rs#L411-L415>
        // <https://github.com/Sovereign-Labs/sovereign-sdk-wip/blob/fdad6aef490656ce4ad6c93f486569acb71d11eb/crates/module-system/sov-modules-api/src/common/address.rs#L365-L369>
        let hrp = Hrp::parse("sov").expect("valid hrp");
        let address = bech32::encode::<Bech32m>(
            hrp,
            &self.0.verifying_key().as_bytes()[..SOV_ADDRESS_LENGTH],
        )
        .map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Encoding public key to bech32 failed: {e}"
            ))
        })?;

        Ok(address)
    }

    fn h256_address(&self) -> H256 {
        let mut h256 = H256::zero();
        h256[SOV_HEX_ADDRESS_LEADING_ZEROS..]
            .copy_from_slice(&self.0.verifying_key().to_bytes()[..SOV_ADDRESS_LENGTH]);
        h256
    }
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
            signer.address().unwrap()
        );
        assert_eq!(
            "0x00000000f8ad2437a279e1c8932c07358c91dc4fe34864a98c6c25f298e2a019",
            format!("{:?}", signer.h256_address()),
        );
    }
}
