use cosmrs::crypto::secp256k1::SigningKey;

use crate::verify;

#[derive(Clone, Debug)]
/// Signer for cosmos chain
pub struct Signer {
    /// prefix for signer address
    pub prefix: String,
    pub(crate) private_key: Vec<u8>,
}

impl Signer {
    /// create new signer
    pub fn new(private_key: Vec<u8>, prefix: String) -> Self {
        Self {
            private_key,
            prefix,
        }
    }

    /// get bech32 address
    pub fn address(&self) -> String {
        verify::pub_to_addr(
            SigningKey::from_slice(self.private_key.as_slice())
                .unwrap()
                .public_key()
                .to_bytes(),
            self.prefix.as_str(),
        )
        .unwrap()
    }
}
