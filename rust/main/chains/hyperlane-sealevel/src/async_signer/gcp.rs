//! GCP Cloud KMS PureEdDSA signing for Sealevel messages.

use std::{fmt, future::Future, sync::Arc};

use async_trait::async_trait;
use ed25519_dalek::{pkcs8::DecodePublicKey, VerifyingKey};
use google_cloud_kms_v1::{
    client::KeyManagementService,
    model::{
        crypto_key_version::CryptoKeyVersionAlgorithm, AsymmetricSignRequest,
        AsymmetricSignResponse, ProtectionLevel, PublicKey,
    },
};
use solana_sdk::{pubkey::Pubkey, signature::Signature};

use super::verify_signature;

/// A remote Ed25519 signer. Private key material is never fetched or exported.
/// Cloud KMS currently supports EC_SIGN_ED25519 with SOFTWARE protection only;
/// this signer deliberately makes no HSM claim.
#[derive(Clone)]
pub struct GcpSealevelSigner {
    transport: Arc<dyn KmsTransport>,
    key_version_name: String,
    pubkey: Pubkey,
}

impl fmt::Debug for GcpSealevelSigner {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GcpSealevelSigner")
            .field("key_version_name", &self.key_version_name)
            .field("pubkey", &self.pubkey)
            .finish()
    }
}

/// Errors making or validating an Ed25519 KMS request.
#[derive(Debug, thiserror::Error)]
pub enum GcpSealevelSignerError {
    /// The resource must pin a concrete numeric crypto key version.
    #[error("Expected a fully qualified GCP crypto key version resource")]
    InvalidKeyVersion,
    /// KMS rejected or failed a request.
    #[error("{0}")]
    Kms(#[from] google_cloud_kms_v1::Error),
    /// The returned PEM is not an Ed25519 SubjectPublicKeyInfo.
    #[error("Invalid GCP Ed25519 public key: {0}")]
    PublicKeyDecode(#[from] ed25519_dalek::pkcs8::spki::Error),
    /// KMS returned metadata for a different key version.
    #[error("Unexpected KMS key version: expected {expected}, got {actual}")]
    UnexpectedKeyVersion {
        /// Requested concrete key version.
        expected: String,
        /// Resource returned by KMS.
        actual: String,
    },
    /// EC_SIGN_ED25519 must use its supported SOFTWARE protection level.
    #[error("Unexpected Ed25519 KMS protection level: {0:?}")]
    UnexpectedProtectionLevel(ProtectionLevel),
    /// A non-Ed25519 key cannot sign Sealevel messages.
    #[error("Unexpected Ed25519 KMS algorithm: {0:?}")]
    UnexpectedAlgorithm(CryptoKeyVersionAlgorithm),
    /// Request/response integrity metadata was missing or did not match.
    #[error("KMS integrity check failed: {0}")]
    IntegrityCheckFailed(&'static str),
    /// A returned signature was malformed or failed strict verification.
    #[error("KMS signature does not verify against the requested message and public key")]
    InvalidSignature,
}

#[async_trait]
trait KmsTransport: Send + Sync {
    async fn public_key(&self, name: &str) -> Result<PublicKey, GcpSealevelSignerError>;
    async fn sign(
        &self,
        request: AsymmetricSignRequest,
    ) -> Result<AsymmetricSignResponse, GcpSealevelSignerError>;
}

struct GcpTransport(KeyManagementService);

#[async_trait]
impl KmsTransport for GcpTransport {
    async fn public_key(&self, name: &str) -> Result<PublicKey, GcpSealevelSignerError> {
        Ok(self.0.get_public_key().set_name(name).send().await?)
    }

    async fn sign(
        &self,
        request: AsymmetricSignRequest,
    ) -> Result<AsymmetricSignResponse, GcpSealevelSignerError> {
        Ok(self
            .0
            .asymmetric_sign()
            .with_request(request)
            .send()
            .await?)
    }
}

// Match the existing EVM GCP signer's policy: at most three attempts, retrying
// only transport-integrity failures. Wrong keys/algorithms/signatures and KMS
// request errors propagate immediately; there is no local-signing fallback.
const MAX_INTEGRITY_ATTEMPTS: usize = 3;

async fn retry_integrity<T, F, Fut>(mut operation: F) -> Result<T, GcpSealevelSignerError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, GcpSealevelSignerError>>,
{
    for attempt in 1..MAX_INTEGRITY_ATTEMPTS {
        match operation().await {
            Err(GcpSealevelSignerError::IntegrityCheckFailed(_)) => {
                tracing::debug!(attempt, "Retrying Ed25519 KMS integrity failure");
            }
            result => return result,
        }
    }
    operation().await
}

fn validate_key_version(name: &str) -> Result<(), GcpSealevelSignerError> {
    let segments: Vec<_> = name.split('/').collect();
    if matches!(
        segments.as_slice(),
        ["projects", project, "locations", location, "keyRings", ring, "cryptoKeys", key, "cryptoKeyVersions", version]
            if !project.is_empty() && !location.is_empty() && !ring.is_empty() && !key.is_empty()
                && version.parse::<u64>().is_ok_and(|number| number > 0)
                && segments.iter().all(|segment| segment.trim() == *segment)
    ) {
        Ok(())
    } else {
        Err(GcpSealevelSignerError::InvalidKeyVersion)
    }
}

impl GcpSealevelSigner {
    /// Fetches and validates a public key once using an existing ambient-ADC client.
    pub async fn new(
        client: KeyManagementService,
        key_version_name: String,
    ) -> Result<Self, GcpSealevelSignerError> {
        Self::from_transport(Arc::new(GcpTransport(client)), key_version_name).await
    }

    async fn from_transport(
        transport: Arc<dyn KmsTransport>,
        key_version_name: String,
    ) -> Result<Self, GcpSealevelSignerError> {
        validate_key_version(&key_version_name)?;
        let pubkey = retry_integrity(|| async {
            let response = transport.public_key(&key_version_name).await?;
            validate_public_key(response, &key_version_name)
        })
        .await?;
        Ok(Self {
            transport,
            key_version_name,
            pubkey,
        })
    }

    /// Returns the cached public key without fetching key material or contacting KMS.
    pub fn pubkey(&self) -> Pubkey {
        self.pubkey
    }

    pub(super) async fn sign_message(
        &self,
        message: &[u8],
    ) -> Result<Signature, GcpSealevelSignerError> {
        let response = retry_integrity(|| async {
            // EC_SIGN_ED25519 is PureEdDSA: supply the raw Solana message in
            // `data`, never a digest or a locally hashed/prehashed substitute.
            let request = AsymmetricSignRequest::new()
                .set_name(&self.key_version_name)
                .set_data(message.to_vec())
                .set_data_crc32c(i64::from(crc32c::crc32c(message)));
            let response = self.transport.sign(request).await?;
            validate_signature_response(&response, &self.key_version_name)?;
            Ok(response)
        })
        .await?;

        let signature = Signature::try_from(response.signature.as_ref())
            .map_err(|_| GcpSealevelSignerError::InvalidSignature)?;
        if !verify_signature(&self.pubkey, message, &signature) {
            return Err(GcpSealevelSignerError::InvalidSignature);
        }
        Ok(signature)
    }
}

fn validate_public_key(
    response: PublicKey,
    expected_name: &str,
) -> Result<Pubkey, GcpSealevelSignerError> {
    validate_response_identity(&response.name, expected_name, &response.protection_level)?;
    if response.algorithm != CryptoKeyVersionAlgorithm::EcSignEd25519 {
        return Err(GcpSealevelSignerError::UnexpectedAlgorithm(
            response.algorithm,
        ));
    }
    if response.pem_crc32c != Some(i64::from(crc32c::crc32c(response.pem.as_bytes()))) {
        return Err(GcpSealevelSignerError::IntegrityCheckFailed(
            "public key PEM CRC32C mismatch or missing",
        ));
    }
    let verifying_key = VerifyingKey::from_public_key_pem(&response.pem)?;
    Ok(Pubkey::new_from_array(verifying_key.to_bytes()))
}

fn validate_response_identity(
    actual_name: &str,
    expected_name: &str,
    protection_level: &ProtectionLevel,
) -> Result<(), GcpSealevelSignerError> {
    if actual_name != expected_name {
        return Err(GcpSealevelSignerError::UnexpectedKeyVersion {
            expected: expected_name.to_owned(),
            actual: actual_name.to_owned(),
        });
    }
    if *protection_level != ProtectionLevel::Software {
        return Err(GcpSealevelSignerError::UnexpectedProtectionLevel(
            protection_level.clone(),
        ));
    }
    Ok(())
}

fn validate_signature_response(
    response: &AsymmetricSignResponse,
    expected_name: &str,
) -> Result<(), GcpSealevelSignerError> {
    validate_response_identity(&response.name, expected_name, &response.protection_level)?;
    if !response.verified_data_crc32c {
        return Err(GcpSealevelSignerError::IntegrityCheckFailed(
            "KMS did not verify the raw message CRC32C",
        ));
    }
    if response.signature_crc32c != Some(i64::from(crc32c::crc32c(&response.signature))) {
        return Err(GcpSealevelSignerError::IntegrityCheckFailed(
            "signature CRC32C mismatch or missing",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    use ed25519_dalek::{
        pkcs8::{spki::der::pem::LineEnding, EncodePublicKey},
        Signer, SigningKey,
    };

    use super::*;

    const KEY_VERSION: &str =
        "projects/test/locations/global/keyRings/test/cryptoKeys/solana/cryptoKeyVersions/1";

    struct MockTransport {
        key: SigningKey,
        public_key: PublicKey,
        responses: Mutex<Vec<AsymmetricSignResponse>>,
        public_key_calls: AtomicUsize,
        sign_calls: AtomicUsize,
    }

    impl MockTransport {
        fn new() -> Self {
            let key = SigningKey::from_bytes(&[7; 32]);
            let pem = key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .unwrap();
            let public_key = PublicKey::new()
                .set_name(KEY_VERSION)
                .set_algorithm(CryptoKeyVersionAlgorithm::EcSignEd25519)
                .set_protection_level(ProtectionLevel::Software)
                .set_pem_crc32c(i64::from(crc32c::crc32c(pem.as_bytes())))
                .set_pem(pem);
            Self {
                key,
                public_key,
                responses: Mutex::new(Vec::new()),
                public_key_calls: AtomicUsize::new(0),
                sign_calls: AtomicUsize::new(0),
            }
        }

        fn signed_response(&self, message: &[u8]) -> AsymmetricSignResponse {
            let signature = self.key.sign(message).to_bytes().to_vec();
            AsymmetricSignResponse::new()
                .set_name(KEY_VERSION)
                .set_protection_level(ProtectionLevel::Software)
                .set_verified_data_crc32c(true)
                .set_signature_crc32c(i64::from(crc32c::crc32c(&signature)))
                .set_signature(signature)
        }
    }

    #[async_trait]
    impl KmsTransport for MockTransport {
        async fn public_key(&self, name: &str) -> Result<PublicKey, GcpSealevelSignerError> {
            assert_eq!(name, KEY_VERSION);
            self.public_key_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.public_key.clone())
        }

        async fn sign(
            &self,
            request: AsymmetricSignRequest,
        ) -> Result<AsymmetricSignResponse, GcpSealevelSignerError> {
            assert_eq!(request.name, KEY_VERSION);
            assert!(
                request.digest.is_none(),
                "Ed25519 must never receive a digest"
            );
            assert!(request.digest_crc32c.is_none());
            assert_eq!(
                request.data_crc32c,
                Some(i64::from(crc32c::crc32c(&request.data)))
            );
            self.sign_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop()
                .unwrap_or_else(|| self.signed_response(&request.data)))
        }
    }

    #[tokio::test]
    async fn signs_raw_messages_and_caches_the_public_key() {
        let transport = Arc::new(MockTransport::new());
        let signer = GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
            .await
            .unwrap();
        assert_eq!(
            signer.pubkey().to_bytes(),
            transport.key.verifying_key().to_bytes()
        );
        for message in [
            b"".as_slice(),
            b"Solana signs the complete serialized message, not a digest",
        ] {
            let signature = signer.sign_message(message).await.unwrap();
            assert!(verify_signature(&signer.pubkey(), message, &signature));
        }
        assert_eq!(transport.public_key_calls.load(Ordering::SeqCst), 1);
        assert_eq!(transport.sign_calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn rejects_wrong_public_key_metadata() {
        let fixture = MockTransport::new();
        for public_key in [
            fixture.public_key.clone().set_name("another/key/version"),
            fixture
                .public_key
                .clone()
                .set_protection_level(ProtectionLevel::Hsm),
            fixture
                .public_key
                .clone()
                .set_algorithm(CryptoKeyVersionAlgorithm::EcSignSecp256K1Sha256),
            fixture.public_key.clone().set_pem_crc32c(0),
        ] {
            assert!(validate_public_key(public_key, KEY_VERSION).is_err());
        }
        let mut missing_crc = fixture.public_key.clone();
        missing_crc.pem_crc32c = None;
        assert!(validate_public_key(missing_crc, KEY_VERSION).is_err());
    }

    #[tokio::test]
    async fn retries_only_integrity_failures_and_bounds_the_attempts() {
        let transport = Arc::new(MockTransport::new());
        let bad_crc = transport
            .signed_response(b"message")
            .set_signature_crc32c(0);
        transport
            .responses
            .lock()
            .unwrap()
            .extend([bad_crc.clone(), bad_crc.clone(), bad_crc]);
        let signer = GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
            .await
            .unwrap();
        assert!(matches!(
            signer.sign_message(b"message").await,
            Err(GcpSealevelSignerError::IntegrityCheckFailed(_))
        ));
        assert_eq!(
            transport.sign_calls.load(Ordering::SeqCst),
            MAX_INTEGRITY_ATTEMPTS
        );
    }

    #[tokio::test]
    async fn rejects_drifted_keys_wrong_messages_and_bad_signatures_without_retry() {
        for mutation in 0..4 {
            let transport = Arc::new(MockTransport::new());
            let mut response = transport.signed_response(b"wrong message");
            match mutation {
                0 => response.name = "another/key/version".to_owned(),
                1 => response.protection_level = ProtectionLevel::Hsm,
                2 => response.signature = vec![0; 64].into(),
                _ => {}
            }
            response.signature_crc32c = Some(i64::from(crc32c::crc32c(&response.signature)));
            transport.responses.lock().unwrap().push(response);
            let signer =
                GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
                    .await
                    .unwrap();
            assert!(signer.sign_message(b"message").await.is_err());
            assert_eq!(transport.sign_calls.load(Ordering::SeqCst), 1);
        }
    }

    #[test]
    fn requires_a_concrete_version_resource() {
        assert!(validate_key_version(KEY_VERSION).is_ok());
        for name in ["", "projects/test/locations/global/keyRings/test/cryptoKeys/solana", "projects/test/locations/global/keyRings/test/cryptoKeys/solana/cryptoKeyVersions/primary", "projects/test/locations/global/keyRings/test/cryptoKeys/solana/cryptoKeyVersions/0"] {
            assert!(matches!(validate_key_version(name), Err(GcpSealevelSignerError::InvalidKeyVersion)));
        }
    }

    #[tokio::test]
    async fn rejects_bad_signer_sets_before_any_remote_signing() {
        use super::super::{transaction_signatures, SealevelSigner, SealevelSignerError};
        use solana_sdk::{
            instruction::{AccountMeta, Instruction},
            message::{Message, VersionedMessage},
        };

        let transport = Arc::new(MockTransport::new());
        let remote = GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
            .await
            .unwrap();
        let payer = SealevelSigner::Gcp(Arc::new(remote));
        let co_signer = SealevelSigner::from(crate::SealevelKeypair::default());
        let unrelated = SealevelSigner::from(crate::SealevelKeypair::default());
        let instruction = Instruction::new_with_bytes(
            Pubkey::new_unique(),
            &[],
            vec![AccountMeta::new_readonly(co_signer.pubkey(), true)],
        );
        let message = VersionedMessage::Legacy(Message::new(&[instruction], Some(&payer.pubkey())));
        assert!(matches!(
            transaction_signatures(&message, &payer, &[]).await,
            Err(SealevelSignerError::MissingSigner(_))
        ));
        assert!(matches!(
            transaction_signatures(&message, &payer, &[&payer, &co_signer]).await,
            Err(SealevelSignerError::DuplicateSigner(_))
        ));
        assert!(matches!(
            transaction_signatures(&message, &payer, &[&unrelated, &co_signer]).await,
            Err(SealevelSignerError::UnexpectedSigner(_))
        ));
        assert!(matches!(
            transaction_signatures(&message, &co_signer, &[&payer]).await,
            Err(SealevelSignerError::InvalidFeePayer { .. })
        ));
        let malformed_prefix = |required_signatures| {
            let mut altered = message.clone();
            if let VersionedMessage::Legacy(inner) = &mut altered {
                inner.header.num_required_signatures = required_signatures;
            }
            altered
        };
        for malformed in [malformed_prefix(0), malformed_prefix(u8::MAX)] {
            assert!(matches!(
                transaction_signatures(&malformed, &payer, &[&co_signer]).await,
                Err(SealevelSignerError::InvalidRequiredSigners)
            ));
        }
        let mut duplicated = message.clone();
        if let VersionedMessage::Legacy(inner) = &mut duplicated {
            inner.account_keys[1] = payer.pubkey();
        }
        assert!(matches!(
            transaction_signatures(&duplicated, &payer, &[&co_signer]).await,
            Err(SealevelSignerError::DuplicateSigner(_))
        ));
        assert_eq!(transport.sign_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn rejects_signature_lengths_and_unverified_request_checksums() {
        for length in [0, 1, 63, 65] {
            let transport = Arc::new(MockTransport::new());
            let signature = vec![0; length];
            let response = transport
                .signed_response(b"message")
                .set_signature_crc32c(i64::from(crc32c::crc32c(&signature)))
                .set_signature(signature);
            transport.responses.lock().unwrap().push(response);
            let signer =
                GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
                    .await
                    .unwrap();
            assert!(matches!(
                signer.sign_message(b"message").await,
                Err(GcpSealevelSignerError::InvalidSignature)
            ));
            assert_eq!(transport.sign_calls.load(Ordering::SeqCst), 1);
        }

        let transport = Arc::new(MockTransport::new());
        let response = transport
            .signed_response(b"message")
            .set_verified_data_crc32c(false)
            .set_verified_digest_crc32c(true);
        transport
            .responses
            .lock()
            .unwrap()
            .extend([response.clone(), response.clone(), response]);
        let signer = GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
            .await
            .unwrap();
        assert!(matches!(
            signer.sign_message(b"message").await,
            Err(GcpSealevelSignerError::IntegrityCheckFailed(_))
        ));
        assert_eq!(
            transport.sign_calls.load(Ordering::SeqCst),
            MAX_INTEGRITY_ATTEMPTS
        );
    }

    #[tokio::test]
    async fn retries_a_corrupt_response_then_verifies_the_replacement() {
        let transport = Arc::new(MockTransport::new());
        transport.responses.lock().unwrap().push(
            transport
                .signed_response(b"message")
                .set_signature_crc32c(0),
        );
        let signer = GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
            .await
            .unwrap();
        assert!(signer.sign_message(b"message").await.is_ok());
        assert_eq!(transport.sign_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn remote_payer_and_local_identity_sign_legacy_and_v0_alt_transactions() {
        use super::super::{transaction_signatures, SealevelSigner};
        use solana_sdk::{
            hash::Hash,
            instruction::{AccountMeta, Instruction},
            message::{v0, AddressLookupTableAccount, Message, VersionedMessage},
            transaction::VersionedTransaction,
        };

        let transport = Arc::new(MockTransport::new());
        let remote = GcpSealevelSigner::from_transport(transport.clone(), KEY_VERSION.to_owned())
            .await
            .unwrap();
        let payer = SealevelSigner::Gcp(Arc::new(remote));
        let identity = SealevelSigner::default();
        let loaded_account = Pubkey::new_unique();
        let instruction = Instruction::new_with_bytes(
            Pubkey::new_unique(),
            &[4, 2],
            vec![
                AccountMeta::new_readonly(identity.pubkey(), true),
                AccountMeta::new(loaded_account, false),
            ],
        );
        let blockhash = Hash::new_unique();
        let legacy =
            Message::new_with_blockhash(&[instruction.clone()], Some(&payer.pubkey()), &blockhash);
        let versioned = v0::Message::try_compile(
            &payer.pubkey(),
            &[instruction],
            &[AddressLookupTableAccount {
                key: Pubkey::new_unique(),
                addresses: vec![loaded_account],
            }],
            blockhash,
        )
        .unwrap();
        assert_eq!(versioned.address_table_lookups.len(), 1);
        for message in [
            VersionedMessage::Legacy(legacy),
            VersionedMessage::V0(versioned),
        ] {
            let signatures = transaction_signatures(&message, &payer, &[&identity])
                .await
                .unwrap();
            let signed = VersionedTransaction {
                signatures,
                message,
            };
            assert_eq!(*signed.message.recent_blockhash(), blockhash);
            assert!(signed.verify_and_hash_message().is_ok());
            assert_eq!(
                signed.signatures.first().unwrap().as_ref(),
                transport.key.sign(&signed.message.serialize()).to_bytes()
            );
        }
        assert_eq!(transport.public_key_calls.load(Ordering::SeqCst), 1);
        assert_eq!(transport.sign_calls.load(Ordering::SeqCst), 2);
    }
}
