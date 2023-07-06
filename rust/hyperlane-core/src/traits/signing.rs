use std::fmt::{Debug, Formatter};

use async_trait::async_trait;
use auto_impl::auto_impl;
use serde::{
    ser::{SerializeStruct, Serializer},
    Deserialize, Serialize,
};

use crate::utils::fmt_bytes;
use crate::{Signature, H160, H256};

// use ethers_core::{
//     types::{Address, Signature},
//     utils::hash_message,
// };

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
    fn verify<T: Signable>(&self, signed: &SignedType<T>) -> Result<(), crate::HyperlaneProtocolError>;
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
    fn verify<T: Signable>(&self, signed: &SignedType<T>) -> Result<(), crate::HyperlaneProtocolError> {
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
    #[cfg(feature = "ethers")]
    fn eth_signed_message_hash(&self) -> H256 {
        ethers_core::utils::hash_message(self.signing_hash()).into()
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
        state.serialize_field("serialized_signature", &fmt_bytes(&sig))?;
        state.end()
    }
}

impl<T: Signable> SignedType<T> {
    /// Recover the Ethereum address of the signer
    #[cfg(feature = "ethers")]
    pub fn recover(&self) -> Result<H160, crate::HyperlaneProtocolError> {
        let hash = ethers_core::types::H256::from(self.value.eth_signed_message_hash());
        let sig = ethers_core::types::Signature::from(self.signature);
        Ok(sig.recover(hash)?.into())
    }

    /// Check whether a message was signed by a specific address
    #[cfg(feature = "ethers")]
    pub fn verify(&self, signer: H160) -> Result<(), crate::HyperlaneProtocolError> {
        let hash = ethers_core::types::H256::from(self.value.eth_signed_message_hash());
        let sig = ethers_core::types::Signature::from(self.signature);
        let signer = ethers_core::types::H160::from(signer);
        Ok(sig.verify(hash, signer)?.into())
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
