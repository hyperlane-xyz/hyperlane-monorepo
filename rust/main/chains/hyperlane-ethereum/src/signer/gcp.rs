//! GCP Cloud KMS-based Signer
//!
//! Mirrors `ethers_signers::AwsSigner`'s approach (see its `aws/mod.rs` and
//! `aws/utils.rs`) but talks to GCP Cloud KMS instead of AWS KMS: the private
//! key never leaves KMS, only `AsymmetricSign` calls go over the wire, and the
//! recovery id (`v`) - which KMS never returns - is derived locally by trial
//! recovery against the public key fetched once at construction time.

use ethers::{
    types::{
        transaction::{eip2718::TypedTransaction, eip712::Eip712},
        Address, Signature as EthSig, H256, U256,
    },
    utils::{hash_message, keccak256},
};
use ethers_signers::Signer;
use google_cloud_kms_v1::{
    client::KeyManagementService,
    model::{Digest, PublicKey},
};
use k256::{
    ecdsa::{RecoveryId, Signature as KSig, VerifyingKey},
    pkcs8::DecodePublicKey,
};
use tracing::{debug, instrument, trace};

/// A signer whose private key is held in GCP Cloud KMS. Only asymmetric-sign
/// operations are ever sent over the wire; the key material never leaves KMS.
#[derive(Clone)]
pub struct GcpSigner {
    client: KeyManagementService,
    /// Fully-qualified resource name of the crypto key version to sign with,
    /// e.g. `projects/p/locations/l/keyRings/k/cryptoKeys/ck/cryptoKeyVersions/1`.
    key_version_name: String,
    chain_id: u64,
    pubkey: VerifyingKey,
    address: Address,
}

impl std::fmt::Debug for GcpSigner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GcpSigner")
            .field("key_version_name", &self.key_version_name)
            .field("chain_id", &self.chain_id)
            .field("address", &self.address)
            .finish()
    }
}

/// Errors produced by the GcpSigner
#[derive(thiserror::Error, Debug)]
pub enum GcpSignerError {
    /// Error making a request to KMS (GetPublicKey / AsymmetricSign)
    #[error("{0}")]
    Kms(#[from] google_cloud_kms_v1::Error),
    /// Error decoding the PEM-encoded public key KMS returned
    #[error("{0}")]
    PublicKeyDecode(#[from] k256::pkcs8::spki::Error),
    /// Error decoding/normalizing the DER-encoded signature KMS returned
    #[error("{0}")]
    K256(#[from] k256::ecdsa::Error),
    /// KMS's signature didn't recover to this signer's known public key under
    /// either recovery id - the signature is unusable.
    #[error("KMS signature does not recover to the expected public key")]
    BadSignature,
    /// Error encoding an EIP-712 typed-data payload
    #[error("error encoding eip712 struct: {0:?}")]
    Eip712Error(String),
}

impl GcpSigner {
    /// Instantiate a new signer from an existing KMS client and crypto key
    /// version resource name.
    ///
    /// This fetches the public key from KMS and derives the Ethereum address,
    /// so it is `async` - mirrors `AwsSigner::new`.
    #[instrument(err, skip(client), fields(key_version_name = %key_version_name))]
    pub async fn new(
        client: KeyManagementService,
        key_version_name: String,
    ) -> Result<Self, GcpSignerError> {
        let response = client
            .get_public_key()
            .set_name(&key_version_name)
            .send()
            .await?;
        let pubkey = decode_pubkey(response)?;
        let address = verifying_key_to_address(&pubkey);

        debug!(
            "Instantiated GCP KMS signer with pubkey 0x{} and address {:?}",
            hex::encode(pubkey.to_encoded_point(false).as_bytes()),
            address,
        );

        Ok(Self {
            client,
            key_version_name,
            // Matches build_aws_signer's placeholder chain_id (signers.rs) - harmless for
            // checkpoint signing (sign_hash normalizes `v` by parity only), but should be
            // set via with_chain_id before this signer ever signs a real transaction.
            chain_id: 0,
            pubkey,
            address,
        })
    }

    /// Sign a 32-byte prehash via KMS `AsymmetricSign`, then derive the
    /// recovery id by trial recovery against this signer's known public key.
    #[instrument(err, skip(self, digest), fields(digest = %hex::encode(digest)))]
    async fn sign_digest(&self, digest: [u8; 32]) -> Result<(KSig, RecoveryId), GcpSignerError> {
        let response = self
            .client
            .asymmetric_sign()
            .set_name(&self.key_version_name)
            .set_digest(Digest::new().set_sha256(digest.to_vec()))
            .send()
            .await?;

        let sig = KSig::from_der(&response.signature)?;
        let sig = sig.normalize_s().unwrap_or(sig);

        let recovery_id = RecoveryId::trial_recovery_from_prehash(&self.pubkey, &digest, &sig)
            .map_err(|_| GcpSignerError::BadSignature)?;

        Ok((sig, recovery_id))
    }

    /// Sign a digest and add the recovery-id-derived `v`, EIP-155-encoded for `chain_id`.
    async fn sign_digest_with_eip155(
        &self,
        digest: H256,
        chain_id: u64,
    ) -> Result<EthSig, GcpSignerError> {
        let (sig, recovery_id) = self.sign_digest(digest.into()).await?;
        let mut sig = ksig_to_ethsig(&sig, recovery_id);
        apply_eip155(&mut sig, chain_id);
        Ok(sig)
    }
}

#[async_trait::async_trait]
impl Signer for GcpSigner {
    type Error = GcpSignerError;

    #[instrument(err, skip(message))]
    async fn sign_message<S: Send + Sync + AsRef<[u8]>>(
        &self,
        message: S,
    ) -> Result<EthSig, Self::Error> {
        let message = message.as_ref();
        let message_hash = hash_message(message);
        trace!(?message_hash, ?message);

        self.sign_digest_with_eip155(message_hash, self.chain_id)
            .await
    }

    #[instrument(err)]
    async fn sign_transaction(&self, tx: &TypedTransaction) -> Result<EthSig, Self::Error> {
        let chain_id = tx.chain_id().map(|id| id.as_u64()).unwrap_or(self.chain_id);
        let sighash = tx.sighash();
        self.sign_digest_with_eip155(sighash, chain_id).await
    }

    async fn sign_typed_data<T: Eip712 + Send + Sync>(
        &self,
        payload: &T,
    ) -> Result<EthSig, Self::Error> {
        let digest = payload
            .encode_eip712()
            .map_err(|e| Self::Error::Eip712Error(e.to_string()))?;

        // EIP-712 signatures are not EIP-155 transactions - v stays 27/28, no chain id offset.
        let (sig, recovery_id) = self.sign_digest(digest).await?;
        Ok(ksig_to_ethsig(&sig, recovery_id))
    }

    fn address(&self) -> Address {
        self.address
    }

    fn chain_id(&self) -> u64 {
        self.chain_id
    }

    fn with_chain_id<T: Into<u64>>(mut self, chain_id: T) -> Self {
        self.chain_id = chain_id.into();
        self
    }
}

/// Converts a signature + derived recovery id into an ethers signature (v = 27/28, no EIP-155 offset yet).
fn ksig_to_ethsig(sig: &KSig, recovery_id: RecoveryId) -> EthSig {
    let v = u64::from(recovery_id.to_byte()).saturating_add(27);
    let (r, s) = sig.split_bytes();
    let r = U256::from_big_endian(r.as_slice());
    let s = U256::from_big_endian(s.as_slice());
    EthSig { r, s, v }
}

/// Modify the v value of a signature to conform to EIP-155.
fn apply_eip155(sig: &mut EthSig, chain_id: u64) {
    sig.v = chain_id
        .saturating_mul(2)
        .saturating_add(35)
        .saturating_add(sig.v.saturating_sub(1).wrapping_rem(2));
}

/// Convert a verifying key to an Ethereum address.
fn verifying_key_to_address(key: &VerifyingKey) -> Address {
    // false for uncompressed
    let uncompressed_pub_key = key.to_encoded_point(false);
    let public_key = uncompressed_pub_key.to_bytes();
    debug_assert_eq!(public_key[0], 0x04);
    let hash = keccak256(&public_key[1..]);
    Address::from_slice(&hash[12..])
}

/// Decode a KMS `GetPublicKey` response's PEM-encoded public key.
fn decode_pubkey(resp: PublicKey) -> Result<VerifyingKey, GcpSignerError> {
    let key = VerifyingKey::from_public_key_pem(&resp.pem)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use ethers::signers::{LocalWallet, Signer as _};
    use k256::ecdsa::{signature::hazmat::PrehashSigner, DerSignature, SigningKey};

    use super::*;

    /// A fixed, arbitrary private key scalar - only used to make these tests deterministic,
    /// not a real key.
    const FIXED_KEY_BYTES: [u8; 32] = [7u8; 32];

    fn fixed_signing_key() -> SigningKey {
        SigningKey::from_slice(&FIXED_KEY_BYTES).expect("valid scalar")
    }

    /// `verifying_key_to_address` must derive the exact same address ethers' own
    /// well-tested `LocalWallet` derives for the same raw key bytes - a cross-check against
    /// an independent, trusted implementation rather than a hardcoded address that could
    /// itself be wrong. Parsed independently from the same bytes (rather than converted)
    /// because `ethers`'s own pinned `k256` and this crate's directly-declared `k256` are
    /// different versions, so their types don't interconvert.
    #[test]
    fn verifying_key_to_address_matches_ethers_wallet() {
        let signing_key = fixed_signing_key();
        let wallet: LocalWallet = hex::encode(FIXED_KEY_BYTES)
            .parse()
            .expect("valid private key hex");
        let address = verifying_key_to_address(signing_key.verifying_key());
        assert_eq!(address, wallet.address());
    }

    /// The DER round trip through `KSig::from_der` (what a real KMS response would need to
    /// go through) must reproduce the same normalized (r, s) as the fixed-size signature
    /// produced directly - proves the DER decode path is lossless.
    #[test]
    fn der_signature_round_trips_through_from_der() {
        let signing_key = fixed_signing_key();
        let digest = keccak256(b"gcp signer der round-trip fixture");

        let der_sig: DerSignature = signing_key
            .sign_prehash(&digest)
            .expect("signing a valid prehash must succeed");
        let fixed_sig: KSig = signing_key
            .sign_prehash(&digest)
            .expect("signing a valid prehash must succeed");

        let parsed = KSig::from_der(der_sig.to_bytes().as_ref()).expect("valid DER signature");
        let parsed = parsed.normalize_s().unwrap_or(parsed);
        let fixed_sig = fixed_sig.normalize_s().unwrap_or(fixed_sig);
        assert_eq!(parsed, fixed_sig);
    }

    /// This is the property that actually matters: given a signature KMS produced (no
    /// recovery id attached) and the signer's known public key, trial recovery must find
    /// the recovery id that makes plain `ecrecover` on `(r, s, v)` alone reproduce the
    /// address derived directly from the public key.
    #[test]
    fn recovery_id_trial_recovery_reconstructs_known_address() {
        let signing_key = fixed_signing_key();
        let verifying_key = *signing_key.verifying_key();
        let address = verifying_key_to_address(&verifying_key);

        let digest = keccak256(b"gcp signer recovery-id fixture");
        let der_sig: DerSignature = signing_key
            .sign_prehash(&digest)
            .expect("signing a valid prehash must succeed");
        let sig = KSig::from_der(der_sig.to_bytes().as_ref()).expect("valid DER signature");
        let sig = sig.normalize_s().unwrap_or(sig);

        let recovery_id = RecoveryId::trial_recovery_from_prehash(&verifying_key, &digest, &sig)
            .expect("a signature produced by this key must recover under one of the two ids");

        let eth_sig = ksig_to_ethsig(&sig, recovery_id);
        let recovered = eth_sig
            .recover(ethers::types::H256::from(digest))
            .expect("a valid (r, s, v) signature must recover to some address");
        assert_eq!(recovered, address);
    }
}
