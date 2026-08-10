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
    model::{
        crypto_key_version::CryptoKeyVersionAlgorithm, AsymmetricSignResponse, Digest,
        ProtectionLevel, PublicKey,
    },
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
    /// KMS signed with a different CryptoKeyVersion than the one requested -
    /// possible proxy/routing bug or resource drift. Fail closed.
    /// Tuple fields are (requested, got).
    #[error("KMS signed with unexpected key version: requested {0}, got {1}")]
    UnexpectedKeyVersion(String, String),
    /// KMS signed with a protection level other than HSM - the HSM guarantee
    /// this signer relies on may not hold. Fail closed.
    #[error("KMS signed with unexpected protection level: {0:?}")]
    UnexpectedProtectionLevel(ProtectionLevel),
    /// The key version's algorithm isn't the secp256k1/SHA-256 this signer
    /// assumes - a drifted or misconfigured key could otherwise produce
    /// signatures this signer misinterprets. Fail closed.
    #[error("KMS key version has unexpected algorithm: {0:?}")]
    UnexpectedAlgorithm(CryptoKeyVersionAlgorithm),
    /// A CRC32C integrity check against a KMS request/response failed -
    /// possible data corruption in transit. Fail closed rather than sign or
    /// trust a payload that didn't round-trip intact.
    #[error("KMS integrity check failed: {0}")]
    IntegrityCheckFailed(&'static str),
    /// Error encoding an EIP-712 typed-data payload
    #[error("error encoding eip712 struct: {0:?}")]
    Eip712Error(String),
}

/// GCP's KMS API docs call out CRC32C mismatches and unverified digest/data
/// checksums as possible in-transit corruption, and specifically recommend
/// discarding the response and performing a limited number of retries for
/// exactly these integrity failures - not for other errors (wrong key
/// version, wrong protection level/algorithm, a real KMS/network error),
/// which aren't transient in the same way and should propagate immediately.
const MAX_INTEGRITY_RETRIES: u32 = 3;

async fn retry_on_integrity_failure<T, Fut>(mut f: impl FnMut() -> Fut) -> Result<T, GcpSignerError>
where
    Fut: std::future::Future<Output = Result<T, GcpSignerError>>,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Err(GcpSignerError::IntegrityCheckFailed(msg))
                if attempt.saturating_add(1) < MAX_INTEGRITY_RETRIES =>
            {
                attempt = attempt.saturating_add(1);
                debug!(
                    attempt,
                    "Retrying KMS call after integrity check failure: {msg}"
                );
            }
            result => return result,
        }
    }
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
        let response = retry_on_integrity_failure(|| {
            fetch_and_validate_public_key(&client, &key_version_name)
        })
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
        let response = retry_on_integrity_failure(|| self.asymmetric_sign_once(digest)).await?;

        let sig = KSig::from_der(&response.signature)?;
        let sig = sig.normalize_s().unwrap_or(sig);

        let recovery_id = RecoveryId::trial_recovery_from_prehash(&self.pubkey, &digest, &sig)
            .map_err(|_| GcpSignerError::BadSignature)?;

        Ok((sig, recovery_id))
    }

    async fn asymmetric_sign_once(
        &self,
        digest: [u8; 32],
    ) -> Result<AsymmetricSignResponse, GcpSignerError> {
        let digest_crc32c = crc32c::crc32c(&digest);
        let response = self
            .client
            .asymmetric_sign()
            .set_name(&self.key_version_name)
            .set_digest(Digest::new().set_sha256(digest.to_vec()))
            .set_digest_crc32c(digest_crc32c as i64)
            .send()
            .await?;

        // Fail closed on integrity/identity metadata KMS returns alongside the
        // signature — a drifted or wrong-protection-level same-name key, or a
        // corrupted request/response, must not silently produce a signature
        // this signer treats as trustworthy.
        if response.name != self.key_version_name {
            return Err(GcpSignerError::UnexpectedKeyVersion(
                self.key_version_name.clone(),
                response.name,
            ));
        }
        if !response.verified_digest_crc32c {
            return Err(GcpSignerError::IntegrityCheckFailed(
                "KMS did not verify the digest CRC32C",
            ));
        }
        if response.protection_level != ProtectionLevel::Hsm {
            return Err(GcpSignerError::UnexpectedProtectionLevel(
                response.protection_level.clone(),
            ));
        }
        if response.signature_crc32c != Some(crc32c::crc32c(&response.signature) as i64) {
            return Err(GcpSignerError::IntegrityCheckFailed(
                "signature CRC32C mismatch",
            ));
        }

        Ok(response)
    }

    /// Sign a 32-byte prehash, returning a raw `(r, s, v = 27/28)` signature
    /// with no EIP-155 encoding. For non-EVM chains (e.g. Tron) that sign
    /// their own transaction formats directly rather than going through
    /// `ethers_signers::Signer`, but still want this signer's KMS
    /// integrity/HSM guarantees and its address to be Ethereum-style.
    pub async fn sign_hash(&self, hash: H256) -> Result<EthSig, GcpSignerError> {
        let (sig, recovery_id) = self.sign_digest(hash.into()).await?;
        Ok(ksig_to_ethsig(&sig, recovery_id))
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

        // EIP-191 personal-message signing, not a transaction - EIP-155 doesn't apply here.
        // Return the canonical v = 27/28 recovery value, not an EIP-155-offset one.
        self.sign_hash(message_hash).await
    }

    #[instrument(err)]
    async fn sign_transaction(&self, tx: &TypedTransaction) -> Result<EthSig, Self::Error> {
        // Chain_id is part of the RLP payload the hash covers for every tx
        // type - resolve it onto a clone before hashing so a tx with no
        // chain_id set signs a hash consistent with the chain_id used below.
        let chain_id = tx.chain_id().map(|id| id.as_u64()).unwrap_or(self.chain_id);
        let mut resolved_tx = tx.clone();
        resolved_tx.set_chain_id(chain_id);
        let sighash = resolved_tx.sighash();

        let (sig, recovery_id) = self.sign_digest(sighash.into()).await?;
        let mut sig = ksig_to_ethsig(&sig, recovery_id);
        // Only `TypedTransaction::Legacy::rlp_signed` appends `v` as-is,
        // expecting EIP-155 encoding. `Eip2930`/`Eip1559`'s `rlp_signed` call
        // `normalize_v(v, chain_id)`, which passes `v` through unchanged only
        // when `v <= 1` - anything else is assumed to be EIP-155-encoded for
        // that tx's own `chain_id` field, which may differ from what we used
        // here if the caller's copy of `tx` has its chain_id set differently
        // (or not at all) after we sign. Leaving `v` as raw recovery parity
        // for typed transactions is correct regardless of that chain_id.
        match resolved_tx {
            TypedTransaction::Legacy(_) => apply_eip155(&mut sig, chain_id),
            TypedTransaction::Eip2930(_) | TypedTransaction::Eip1559(_) => {
                sig.v = u64::from(recovery_id.to_byte());
            }
        }
        Ok(sig)
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

async fn fetch_and_validate_public_key(
    client: &KeyManagementService,
    key_version_name: &str,
) -> Result<PublicKey, GcpSignerError> {
    let response = client
        .get_public_key()
        .set_name(key_version_name)
        .send()
        .await?;

    if response.name != key_version_name {
        return Err(GcpSignerError::UnexpectedKeyVersion(
            key_version_name.to_owned(),
            response.name,
        ));
    }
    if response.protection_level != ProtectionLevel::Hsm {
        return Err(GcpSignerError::UnexpectedProtectionLevel(
            response.protection_level.clone(),
        ));
    }
    if response.algorithm != CryptoKeyVersionAlgorithm::EcSignSecp256K1Sha256 {
        return Err(GcpSignerError::UnexpectedAlgorithm(
            response.algorithm.clone(),
        ));
    }
    match response.pem_crc32c {
        Some(expected) if crc32c::crc32c(response.pem.as_bytes()) as i64 == expected => {}
        Some(_) => {
            return Err(GcpSignerError::IntegrityCheckFailed(
                "public key PEM CRC32C mismatch",
            ));
        }
        None => {
            return Err(GcpSignerError::IntegrityCheckFailed(
                "public key PEM response missing CRC32C integrity field",
            ));
        }
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

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

    /// `sign_message` (EIP-191 personal-message signing, e.g. Hyperlane checkpoint/announcement
    /// signing) must return the canonical v = 27/28 recovery value, not an EIP-155-offset one -
    /// this exercises the exact digest-to-signature path `sign_message` now uses (hash via
    /// `hash_message`, then `ksig_to_ethsig` with no `apply_eip155`), without needing a live KMS
    /// client.
    #[test]
    fn sign_message_path_produces_canonical_recovery_value() {
        let signing_key = fixed_signing_key();
        let verifying_key = *signing_key.verifying_key();
        let address = verifying_key_to_address(&verifying_key);

        let message = b"gcp signer personal-sign fixture";
        let message_hash = hash_message(message);
        let digest: [u8; 32] = message_hash.into();

        let der_sig: DerSignature = signing_key
            .sign_prehash(&digest)
            .expect("signing a valid prehash must succeed");
        let sig = KSig::from_der(der_sig.to_bytes().as_ref()).expect("valid DER signature");
        let sig = sig.normalize_s().unwrap_or(sig);
        let recovery_id = RecoveryId::trial_recovery_from_prehash(&verifying_key, &digest, &sig)
            .expect("a signature produced by this key must recover under one of the two ids");

        let eth_sig = ksig_to_ethsig(&sig, recovery_id);
        assert!(
            eth_sig.v == 27 || eth_sig.v == 28,
            "expected canonical recovery value 27/28, got {}",
            eth_sig.v
        );

        let recovered = eth_sig
            .recover(message.to_vec())
            .expect("a valid canonical (r, s, v) signature must recover the message signer");
        assert_eq!(recovered, address);
    }

    /// A call that succeeds on the first attempt must not be retried at all.
    #[tokio::test]
    async fn retry_on_integrity_failure_does_not_retry_a_successful_call() {
        let calls = Cell::new(0u32);
        let result: Result<u32, GcpSignerError> = retry_on_integrity_failure(|| {
            calls.set(calls.get() + 1);
            async { Ok(42) }
        })
        .await;
        assert_eq!(result.expect("must succeed"), 42);
        assert_eq!(calls.get(), 1);
    }

    /// A call that fails with a transient integrity error and then succeeds must be retried
    /// until it succeeds, without exhausting the retry budget.
    #[tokio::test]
    async fn retry_on_integrity_failure_retries_transient_failures_until_success() {
        let calls = Cell::new(0u32);
        let result: Result<u32, GcpSignerError> = retry_on_integrity_failure(|| {
            let attempt = calls.get();
            calls.set(attempt + 1);
            async move {
                if attempt < 2 {
                    Err(GcpSignerError::IntegrityCheckFailed("crc32c mismatch"))
                } else {
                    Ok(99)
                }
            }
        })
        .await;
        assert_eq!(result.expect("must eventually succeed"), 99);
        assert_eq!(calls.get(), 3);
    }

    /// A call that always fails with an integrity error must be attempted exactly
    /// `MAX_INTEGRITY_RETRIES` times, then propagate the failure - not retried forever.
    #[tokio::test]
    async fn retry_on_integrity_failure_gives_up_after_max_attempts() {
        let calls = Cell::new(0u32);
        let result: Result<u32, GcpSignerError> = retry_on_integrity_failure(|| {
            calls.set(calls.get() + 1);
            async { Err(GcpSignerError::IntegrityCheckFailed("crc32c mismatch")) }
        })
        .await;
        assert!(matches!(
            result,
            Err(GcpSignerError::IntegrityCheckFailed(_))
        ));
        assert_eq!(calls.get(), MAX_INTEGRITY_RETRIES);
    }

    /// A non-integrity error must propagate immediately, without being retried.
    #[tokio::test]
    async fn retry_on_integrity_failure_does_not_retry_other_errors() {
        let calls = Cell::new(0u32);
        let result: Result<u32, GcpSignerError> = retry_on_integrity_failure(|| {
            calls.set(calls.get() + 1);
            async {
                Err(GcpSignerError::Eip712Error(
                    "not an integrity error".to_string(),
                ))
            }
        })
        .await;
        assert!(matches!(result, Err(GcpSignerError::Eip712Error(_))));
        assert_eq!(calls.get(), 1);
    }
}
