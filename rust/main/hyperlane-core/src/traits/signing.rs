use std::fmt::{Debug, Formatter};

use async_trait::async_trait;
use auto_impl::auto_impl;
use serde::{
    ser::{SerializeStruct, Serializer},
    Deserialize, Serialize,
};

use crate::utils::bytes_to_hex;
use crate::{Signature, H160, H256};

/// An error incurred by a signer
#[derive(thiserror::Error, Debug)]
#[error(transparent)]
pub struct HyperlaneSignerError(#[from] Box<dyn std::error::Error + Send + Sync>);

/// A hyperlane signer for use by the validators. Currently signers will always
/// use ethereum wallets.
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait HyperlaneSigner: Send + Sync + Debug {
    /// The signer's address
    fn eth_address(&self) -> H160;

    /// Sign a hyperlane checkpoint hash. This must be a signature without eip
    /// 155.
    async fn sign_hash(&self, hash: &H256) -> Result<Signature, HyperlaneSignerError>;
}

/// Auto-implemented extension trait for HyperlaneSigner.
#[async_trait]
pub trait HyperlaneSignerExt {
    /// Sign a `Signable` value
    async fn sign<T: Signable + Send>(
        &self,
        value: T,
    ) -> Result<SignedType<T>, HyperlaneSignerError>;

    /// Check whether a message was signed by a specific address.
    #[cfg(feature = "ethers")]
    fn verify<T: Signable>(
        &self,
        signed: &SignedType<T>,
    ) -> Result<(), crate::HyperlaneProtocolError>;
}

#[async_trait]
impl<S: HyperlaneSigner> HyperlaneSignerExt for S {
    async fn sign<T: Signable + Send>(
        &self,
        value: T,
    ) -> Result<SignedType<T>, HyperlaneSignerError> {
        let signing_hash = value.signing_hash();
        let signature = self.sign_hash(&signing_hash).await?;

        Ok(SignedType { value, signature })
    }

    #[cfg(feature = "ethers")]
    fn verify<T: Signable>(
        &self,
        signed: &SignedType<T>,
    ) -> Result<(), crate::HyperlaneProtocolError> {
        signed.verify(self.eth_address())
    }
}

/// A type that can be signed. The signature will be of a hash of select
/// contents defined by `signing_hash`.
#[async_trait]
pub trait Signable: Sized {
    /// A hash of the contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    fn signing_hash(&self) -> H256;

    /// EIP-191 compliant hash of the signing hash.
    fn eth_signed_message_hash(&self) -> H256 {
        hashes::hash_message(self.signing_hash())
    }
}

/// A signed type. Contains the original value and the signature.
#[derive(Clone, Eq, PartialEq, Deserialize)]
pub struct SignedType<T: Signable> {
    /// The value which was signed
    #[serde(alias = "checkpoint")]
    #[serde(alias = "announcement")]
    pub value: T,
    /// The signature for the value
    pub signature: Signature,
}

impl<T: Signable + Serialize> Serialize for SignedType<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("SignedType", 3)?;
        state.serialize_field("value", &self.value)?;
        state.serialize_field("signature", &self.signature)?;
        let sig: [u8; 65] = self.signature.into();
        state.serialize_field("serialized_signature", &bytes_to_hex(&sig))?;
        state.end()
    }
}

impl<T: Signable> SignedType<T> {
    /// Recover the Ethereum address of the signer
    #[cfg(feature = "ethers")]
    pub fn recover(&self) -> Result<H160, crate::HyperlaneProtocolError> {
        let hash = ethers_core::types::H256::from(self.value.eth_signed_message_hash());
        let sig = ethers_core::types::Signature::from(self.signature);

        Ok(sig.recover(hash).map_err(Box::new)?.into())
    }

    /// Check whether a message was signed by a specific address
    #[cfg(feature = "ethers")]
    pub fn verify(&self, signer: H160) -> Result<(), crate::HyperlaneProtocolError> {
        let hash = ethers_core::types::H256::from(self.value.eth_signed_message_hash());
        let sig = ethers_core::types::Signature::from(self.signature);
        let signer = ethers_core::types::H160::from(signer);
        Ok(sig.verify(hash, signer).map_err(Box::new)?)
    }
}

impl<T: Signable + Debug> Debug for SignedType<T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SignedType {{ value: {:?}, signature: 0x{} }}",
            self.value, self.signature
        )
    }
}

// Copied from https://github.com/hyperlane-xyz/ethers-rs/blob/hyperlane/ethers-core/src/utils/hash.rs
// so that we can get EIP-191 hashing without the `ethers` feature
mod hashes {
    const PREFIX: &str = "\x19Ethereum Signed Message:\n";
    use crate::H256;
    use tiny_keccak::{Hasher, Keccak};

    /// Hash a message according to EIP-191.
    ///
    /// The data is a UTF-8 encoded string and will enveloped as follows:
    /// `"\x19Ethereum Signed Message:\n" + message.length + message` and hashed
    /// using keccak256.
    pub fn hash_message<S>(message: S) -> H256
    where
        S: AsRef<[u8]>,
    {
        let message = message.as_ref();

        let mut eth_message = format!("{PREFIX}{}", message.len()).into_bytes();
        eth_message.extend_from_slice(message);
        keccak256(&eth_message).into()
    }

    /// Compute the Keccak-256 hash of input bytes.
    // TODO: Add Solidity Keccak256 packing support
    pub fn keccak256<S>(bytes: S) -> [u8; 32]
    where
        S: AsRef<[u8]>,
    {
        let mut output = [0u8; 32];
        let mut hasher = Keccak::v256();
        hasher.update(bytes.as_ref());
        hasher.finalize(&mut output);
        output
    }

    #[test]
    #[cfg(feature = "ethers")]
    fn ensure_signed_hashes_match() {
        assert_eq!(
            ethers_core::utils::hash_message(b"gm crypto!"),
            hash_message(b"gm crypto!").into()
        );
        assert_eq!(
            ethers_core::utils::hash_message(b"hyperlane"),
            hash_message(b"hyperlane").into()
        );
    }
}
