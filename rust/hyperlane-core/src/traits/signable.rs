use async_trait::async_trait;
use ethers::prelude::{Address, Signature};
use ethers::utils::hash_message;
use serde::{Deserialize, Serialize};

use crate::{HyperlaneProtocolError, HyperlaneSigner, HyperlaneSignerError, H256};

/// A type that can be signed. The signature will be of a hash of select
/// contents defined by `signing_hash`.
#[async_trait]
pub trait Signable: Sized {
    /// A hash of the contents.
    /// The EIP-191 compliant version of this hash is signed by validators.
    fn signing_hash(&self) -> H256;

    /// EIP-191 compliant hash of the signing hash.
    fn eth_signed_message_hash(&self) -> H256 {
        hash_message(self.signing_hash())
    }

    /// Sign using the specified signer
    async fn sign_with(
        self,
        signer: &impl HyperlaneSigner,
    ) -> Result<SignedType<Self>, HyperlaneSignerError>;
}

/// A signed type. Contains the original value and the signature.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SignedType<T: Signable> {
    /// The value which was signed
    pub value: T,
    /// The signature for the value
    pub signature: Signature,
}

impl<T: Signable> SignedType<T> {
    /// Recover the Ethereum address of the signer
    pub fn recover(&self) -> Result<Address, HyperlaneProtocolError> {
        Ok(self
            .signature
            .recover(self.value.eth_signed_message_hash())?)
    }

    /// Check whether a message was signed by a specific address
    pub fn verify(&self, signer: Address) -> Result<(), HyperlaneProtocolError> {
        Ok(self
            .signature
            .verify(self.value.eth_signed_message_hash(), signer)?)
    }
}
