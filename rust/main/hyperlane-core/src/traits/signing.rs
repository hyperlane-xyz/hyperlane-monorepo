use std::fmt::{Debug, Formatter};

use async_trait::async_trait;
use auto_impl::auto_impl;
use serde::{
    ser::{Error, SerializeStruct, Serializer},
    Deserialize, Serialize,
};

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
        // The prefixed hex representation has a fixed size. Serialize it directly
        // from the stack instead of allocating an intermediate hex String.
        let mut encoded = [0u8; 132];
        encoded[..2].copy_from_slice(b"0x");
        hex::encode_to_slice(sig, &mut encoded[2..]).map_err(S::Error::custom)?;
        let encoded = std::str::from_utf8(&encoded).map_err(S::Error::custom)?;
        state.serialize_field("serialized_signature", encoded)?;
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

// EIP-191 hashing without the `ethers` feature.
mod hashes {
    use crate::H256;
    use tiny_keccak::{Hasher, Keccak};

    /// Wrap a signing hash in EIP-191. Signable always supplies exactly 32 bytes.
    pub fn hash_message(message: H256) -> H256 {
        let mut output = [0u8; 32];
        let mut hasher = Keccak::v256();
        hasher.update(b"\x19Ethereum Signed Message:\n32");
        hasher.update(message.as_ref());
        hasher.finalize(&mut output);
        output.into()
    }

    #[test]
    fn signed_hashes_match_legacy_envelope() {
        // Compare the streamed implementation with the original concatenated
        // envelope for every repeated byte and every single-bit position.
        let values = (0..=u8::MAX)
            .map(H256::repeat_byte)
            .chain((0..256).map(|bit| {
                let mut bytes = [0; 32];
                bytes[bit / 8] = 1 << (bit % 8);
                H256::from(bytes)
            }));
        for value in values {
            let mut envelope =
                format!("\x19Ethereum Signed Message:\n{}", value.as_bytes().len()).into_bytes();
            envelope.extend_from_slice(value.as_bytes());
            let mut expected = [0; 32];
            let mut hasher = Keccak::v256();
            hasher.update(&envelope);
            hasher.finalize(&mut expected);
            assert_eq!(hash_message(value), H256::from(expected));
            #[cfg(feature = "ethers")]
            assert_eq!(
                hash_message(value),
                H256::from(ethers_core::utils::hash_message(value.as_bytes()).0)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Checkpoint, CheckpointWithMessageId, U256};

    struct LegacySigned<'a>(&'a SignedType<CheckpointWithMessageId>);

    impl Serialize for LegacySigned<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut state = serializer.serialize_struct("SignedType", 3)?;
            state.serialize_field("value", &self.0.value)?;
            state.serialize_field("signature", &self.0.signature)?;
            let sig: [u8; 65] = self.0.signature.into();
            state.serialize_field("serialized_signature", &crate::utils::bytes_to_hex(&sig))?;
            state.end()
        }
    }

    #[test]
    fn signed_json_preserves_signature_encoding_and_roundtrip() {
        for v in [0, 1, 27, 28, 255, 256, u64::MAX] {
            for limb in [U256::zero(), U256::one(), U256::MAX] {
                let signed = SignedType {
                    value: CheckpointWithMessageId {
                        checkpoint: Checkpoint {
                            merkle_tree_hook_address: H256::repeat_byte(0x11),
                            mailbox_domain: 42161,
                            root: H256::repeat_byte(0x22),
                            index: 2_500_000,
                        },
                        message_id: H256::repeat_byte(0x33),
                    },
                    signature: Signature {
                        r: limb,
                        s: limb,
                        v,
                    },
                };
                let json = serde_json::to_vec(&signed).unwrap();
                assert_eq!(json, serde_json::to_vec(&LegacySigned(&signed)).unwrap());
                assert_eq!(
                    serde_json::to_vec_pretty(&signed).unwrap(),
                    serde_json::to_vec_pretty(&LegacySigned(&signed)).unwrap()
                );
                let decoded: SignedType<CheckpointWithMessageId> =
                    serde_json::from_slice(&json).unwrap();
                assert_eq!(decoded, signed);
                let json: serde_json::Value = serde_json::from_slice(&json).unwrap();
                assert_eq!(json["serialized_signature"].as_str().unwrap().len(), 132);
            }
        }
    }
}
