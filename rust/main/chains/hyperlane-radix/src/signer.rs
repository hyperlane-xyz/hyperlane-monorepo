use radix_transactions::signing::PrivateKey;
use scrypto::{crypto::Ed25519PrivateKey, types::ComponentAddress};

use hyperlane_core::{ChainResult, H256};

use crate::{address_to_h256, encode_module_address, HyperlaneRadixError};

#[derive(Clone, Debug)]
/// Signer for radix chain
pub struct RadixSigner {
    private_key: Vec<u8>,
    /// encoded address as bech32 and network prefix
    pub encoded_address: String,
    /// H256 address encoding
    pub address_256: H256,
    /// Radix struct representation
    pub address: ComponentAddress,
}

impl RadixSigner {
    /// create new signer
    pub fn new(private_key_bytes: Vec<u8>, suffix: String) -> ChainResult<Self> {
        let private_key = Ed25519PrivateKey::from_bytes(&private_key_bytes)
            .map_err(|()| HyperlaneRadixError::Other("failed to build private key".to_owned()))?;
        let signer = PrivateKey::Ed25519(private_key);
        let public_key = signer.public_key();
        let address = ComponentAddress::preallocated_account_from_public_key(&public_key);
        let address_256 = address_to_h256(address);
        let encoded_address = encode_module_address("account", &suffix, address_256)?; // TODO: there has to be a constant in radix that defines this

        Ok(Self {
            private_key: private_key_bytes,
            address,
            encoded_address,
            address_256,
        })
    }

    /// Returns a radix private key primitive type that can be used to sign tx
    pub fn get_signer(&self) -> ChainResult<PrivateKey> {
        let private_key = Ed25519PrivateKey::from_bytes(&self.private_key)
            .map_err(|()| HyperlaneRadixError::Other("failed to build private key".to_owned()))?;
        let signer = PrivateKey::Ed25519(private_key);
        Ok(signer)
    }
}
