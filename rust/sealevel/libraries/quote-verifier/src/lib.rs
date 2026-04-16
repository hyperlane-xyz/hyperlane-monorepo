//! Shared quote verification logic for Hyperlane SVM programs.
//!
//! Compiled into the fee program and (future) IGP program — not a separate on-chain program.
//! Provides SvmSignedQuote struct, message hash construction, secp256k1 signature
//! verification, and scoped salt computation.

use std::collections::BTreeSet;

use borsh::{BorshDeserialize, BorshSerialize};
use ecdsa_signature::EcdsaSignature;
use hyperlane_core::{H160, H256};
use solana_program::{keccak, pubkey::Pubkey};

/// Domain tag prepended to the message hash to prevent cross-protocol replay.
const DOMAIN_TAG: &[u8] = b"HyperlaneSvmQuote";

/// A signed offchain quote for fee or IGP parameters.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub struct SvmSignedQuote {
    /// Fee-type-specific context bytes (variable length).
    pub context: Vec<u8>,
    /// Fee params bytes (variable length).
    pub data: Vec<u8>,
    /// When the quote was issued (u48 BE, 6 bytes).
    pub issued_at: [u8; 6],
    /// When the quote expires (u48 BE, 6 bytes).
    /// expiry == issued_at → transient; expiry > issued_at → standing.
    pub expiry: [u8; 6],
    /// Client-provided random salt for PDA derivation and replay prevention.
    pub client_salt: H256,
    /// secp256k1 signature (r: 32, s: 32, v: 1) = 65 bytes.
    pub signature: [u8; 65],
}

/// Errors from quote verification.
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
pub enum QuoteVerifyError {
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Recovered signer is not authorized")]
    UnauthorizedSigner,
}

impl SvmSignedQuote {
    /// Returns true if the quote is transient (expiry == issued_at).
    pub fn is_transient(&self) -> bool {
        self.expiry == self.issued_at
    }

    /// Decodes the issued_at field from u48 BE (6 bytes) into an i64 timestamp.
    pub fn issued_at_timestamp(&self) -> i64 {
        decode_u48_timestamp(&self.issued_at)
    }

    /// Decodes the expiry field from u48 BE (6 bytes) into an i64 timestamp.
    pub fn expiry_timestamp(&self) -> i64 {
        decode_u48_timestamp(&self.expiry)
    }

    /// Computes the scoped salt: keccak256(payer || client_salt).
    /// Binds the quote to a specific payer to prevent front-running.
    pub fn compute_scoped_salt(&self, payer: &Pubkey) -> H256 {
        let hash = keccak::hashv(&[payer.as_ref(), self.client_salt.as_bytes()]);
        H256::from_slice(hash.as_ref())
    }

    /// Builds the message hash that was signed by the quote signer.
    ///
    /// ```text
    /// message = keccak256(
    ///     "HyperlaneSvmQuote" ||
    ///     fee_account_pubkey (32 bytes) ||
    ///     domain_id (u32 LE, 4 bytes) ||
    ///     keccak256(context) (32 bytes) ||
    ///     keccak256(data) (32 bytes) ||
    ///     issued_at (6 bytes BE) ||
    ///     expiry (6 bytes BE) ||
    ///     scoped_salt (32 bytes)
    /// )
    /// ```
    pub fn build_message_hash(
        &self,
        fee_account: &Pubkey,
        domain_id: u32,
        scoped_salt: &H256,
    ) -> H256 {
        let context_hash = keccak::hash(&self.context);
        let data_hash = keccak::hash(&self.data);

        let hash = keccak::hashv(&[
            DOMAIN_TAG,
            fee_account.as_ref(),
            &domain_id.to_le_bytes(),
            context_hash.as_ref(),
            data_hash.as_ref(),
            &self.issued_at,
            &self.expiry,
            scoped_salt.as_bytes(),
        ]);

        H256::from_slice(hash.as_ref())
    }

    /// Verifies the quote signature and returns the recovered signer address.
    ///
    /// 1. Computes scoped_salt from payer + client_salt
    /// 2. Builds the message hash
    /// 3. Recovers the secp256k1 signer from the signature
    /// 4. Checks the recovered signer is in the authorized set
    pub fn verify_signer(
        &self,
        fee_account: &Pubkey,
        domain_id: u32,
        payer: &Pubkey,
        authorized_signers: &BTreeSet<H160>,
    ) -> Result<H160, QuoteVerifyError> {
        let scoped_salt = self.compute_scoped_salt(payer);
        let message_hash = self.build_message_hash(fee_account, domain_id, &scoped_salt);

        let ecdsa_sig = EcdsaSignature::from_bytes(&self.signature)
            .map_err(|_| QuoteVerifyError::InvalidSignature)?;

        let recovered_signer = ecdsa_sig
            .secp256k1_recover_ethereum_address(message_hash.as_bytes())
            .map_err(|_| QuoteVerifyError::InvalidSignature)?;

        if !authorized_signers.contains(&recovered_signer) {
            return Err(QuoteVerifyError::UnauthorizedSigner);
        }

        Ok(recovered_signer)
    }
}

/// Decodes a u48 BE (6 bytes) into an i64 timestamp.
fn decode_u48_timestamp(bytes: &[u8; 6]) -> i64 {
    let mut buf = [0u8; 8];
    buf[2..8].copy_from_slice(bytes);
    i64::from_be_bytes(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::{RecoveryId, Signature, SigningKey, VerifyingKey};

    fn make_quote(
        context: Vec<u8>,
        data: Vec<u8>,
        issued_at: [u8; 6],
        expiry: [u8; 6],
    ) -> SvmSignedQuote {
        SvmSignedQuote {
            context,
            data,
            issued_at,
            expiry,
            client_salt: H256::random(),
            signature: [0u8; 65],
        }
    }

    /// Signs a message hash with a k256 private key and returns the 65-byte signature.
    fn sign_hash(signing_key: &SigningKey, hash: &[u8; 32]) -> [u8; 65] {
        let (sig, recovery_id) = signing_key
            .sign_prehash_recoverable(hash)
            .expect("signing failed");
        let mut bytes = [0u8; 65];
        bytes[..64].copy_from_slice(&sig.to_bytes());
        bytes[64] = recovery_id.to_byte();
        bytes
    }

    /// Derives the Ethereum address (H160) from a k256 signing key.
    fn eth_address(signing_key: &SigningKey) -> H160 {
        let verifying_key = VerifyingKey::from(signing_key);
        let pubkey_bytes = verifying_key.to_encoded_point(false);
        // Skip the 0x04 prefix byte, hash the 64-byte uncompressed public key.
        let hash = keccak::hash(&pubkey_bytes.as_bytes()[1..]);
        H160::from_slice(&hash.as_ref()[12..])
    }

    /// Creates a fully signed quote using a k256 signing key.
    fn make_signed_quote(
        signing_key: &SigningKey,
        fee_account: &Pubkey,
        domain_id: u32,
        payer: &Pubkey,
        context: Vec<u8>,
        data: Vec<u8>,
        issued_at: [u8; 6],
        expiry: [u8; 6],
    ) -> SvmSignedQuote {
        let client_salt = H256::random();
        let mut quote = SvmSignedQuote {
            context,
            data,
            issued_at,
            expiry,
            client_salt,
            signature: [0u8; 65],
        };
        let scoped_salt = quote.compute_scoped_salt(payer);
        let message_hash = quote.build_message_hash(fee_account, domain_id, &scoped_salt);
        quote.signature = sign_hash(signing_key, message_hash.as_fixed_bytes());
        quote
    }

    // --- Scoped salt ---

    #[test]
    fn test_scoped_salt_deterministic() {
        let payer = Pubkey::new_unique();
        let quote = make_quote(vec![], vec![], [0; 6], [0; 6]);
        assert_eq!(
            quote.compute_scoped_salt(&payer),
            quote.compute_scoped_salt(&payer),
        );
    }

    #[test]
    fn test_scoped_salt_different_payers() {
        let quote = make_quote(vec![], vec![], [0; 6], [0; 6]);
        assert_ne!(
            quote.compute_scoped_salt(&Pubkey::new_unique()),
            quote.compute_scoped_salt(&Pubkey::new_unique()),
        );
    }

    #[test]
    fn test_scoped_salt_different_client_salts() {
        let payer = Pubkey::new_unique();
        let q1 = make_quote(vec![], vec![], [0; 6], [0; 6]);
        let q2 = make_quote(vec![], vec![], [0; 6], [0; 6]);
        assert_ne!(
            q1.compute_scoped_salt(&payer),
            q2.compute_scoped_salt(&payer),
        );
    }

    // --- Message hash ---

    #[test]
    fn test_message_hash_deterministic() {
        let fee_account = Pubkey::new_unique();
        let scoped_salt = H256::random();
        let quote = make_quote(
            vec![1, 2, 3],
            vec![4, 5, 6],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 2],
        );

        assert_eq!(
            quote.build_message_hash(&fee_account, 42, &scoped_salt),
            quote.build_message_hash(&fee_account, 42, &scoped_salt),
        );
    }

    #[test]
    fn test_message_hash_different_domains() {
        let fee_account = Pubkey::new_unique();
        let scoped_salt = H256::random();
        let quote = make_quote(vec![1], vec![2], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 2]);

        assert_ne!(
            quote.build_message_hash(&fee_account, 1, &scoped_salt),
            quote.build_message_hash(&fee_account, 2, &scoped_salt),
        );
    }

    #[test]
    fn test_message_hash_different_fee_accounts() {
        let scoped_salt = H256::random();
        let quote = make_quote(vec![1], vec![2], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 2]);

        assert_ne!(
            quote.build_message_hash(&Pubkey::new_unique(), 42, &scoped_salt),
            quote.build_message_hash(&Pubkey::new_unique(), 42, &scoped_salt),
        );
    }

    #[test]
    fn test_message_hash_different_context() {
        let fee_account = Pubkey::new_unique();
        let scoped_salt = H256::random();
        let q1 = SvmSignedQuote {
            context: vec![1],
            data: vec![2],
            issued_at: [0; 6],
            expiry: [0; 6],
            client_salt: H256::zero(),
            signature: [0u8; 65],
        };
        let q2 = SvmSignedQuote {
            context: vec![99],
            ..q1.clone()
        };

        assert_ne!(
            q1.build_message_hash(&fee_account, 42, &scoped_salt),
            q2.build_message_hash(&fee_account, 42, &scoped_salt),
        );
    }

    // --- Timestamps ---

    #[test]
    fn test_decode_u48_timestamp() {
        assert_eq!(decode_u48_timestamp(&[0, 0, 0, 0, 0, 0]), 0);
        assert_eq!(decode_u48_timestamp(&[0, 0, 0, 0, 0, 1]), 1);
        assert_eq!(decode_u48_timestamp(&[0, 0, 0, 0, 1, 0]), 256);
        assert_eq!(
            decode_u48_timestamp(&[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]),
            281474976710655 // 2^48 - 1
        );
    }

    #[test]
    fn test_issued_at_and_expiry_timestamps() {
        let quote = make_quote(vec![], vec![], [0, 0, 0, 0, 0, 100], [0, 0, 0, 0, 0, 200]);
        assert_eq!(quote.issued_at_timestamp(), 100);
        assert_eq!(quote.expiry_timestamp(), 200);
    }

    // --- Transient detection ---

    #[test]
    fn test_is_transient() {
        let transient = make_quote(vec![], vec![], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 1]);
        assert!(transient.is_transient());

        let standing = make_quote(vec![], vec![], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 2]);
        assert!(!standing.is_transient());
    }

    // --- Signature verification (full round-trip with k256) ---

    #[test]
    fn test_verify_valid_signature() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let domain_id = 42u32;
        let payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            domain_id,
            &payer,
            vec![1, 2, 3],
            vec![4, 5, 6],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        let mut signers = BTreeSet::new();
        signers.insert(signer_address);

        let recovered = quote
            .verify_signer(&fee_account, domain_id, &payer, &signers)
            .unwrap();
        assert_eq!(recovered, signer_address);
    }

    #[test]
    fn test_verify_wrong_payer_fails() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let domain_id = 42u32;
        let payer = Pubkey::new_unique();
        let wrong_payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            domain_id,
            &payer,
            vec![1, 2, 3],
            vec![4, 5, 6],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        let mut signers = BTreeSet::new();
        signers.insert(signer_address);

        // Verify with wrong payer → scoped salt mismatch → different hash → wrong signer.
        let result = quote.verify_signer(&fee_account, domain_id, &wrong_payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_unauthorized_signer() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());

        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![],
            vec![],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        // Use a different address in the authorized set.
        let mut signers = BTreeSet::new();
        signers.insert(H160::random());

        let result = quote.verify_signer(&fee_account, 42, &payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_invalid_signature() {
        let quote = make_quote(vec![1], vec![2], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 0, 1]);

        let mut signers = BTreeSet::new();
        signers.insert(H160::random());

        let result =
            quote.verify_signer(&Pubkey::new_unique(), 42, &Pubkey::new_unique(), &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::InvalidSignature);
    }

    #[test]
    fn test_verify_empty_signers() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![],
            vec![],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        let result = quote.verify_signer(&fee_account, 42, &payer, &BTreeSet::new());
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_wrong_domain_fails() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![],
            vec![],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        let mut signers = BTreeSet::new();
        signers.insert(signer_address);

        // Verify with wrong domain → different hash → wrong signer.
        let result = quote.verify_signer(&fee_account, 99, &payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_wrong_fee_account_fails() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let wrong_fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![1, 2],
            vec![3, 4],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        let mut signers = BTreeSet::new();
        signers.insert(signer_address);

        let result = quote.verify_signer(&wrong_fee_account, 42, &payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_tampered_context_fails() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let mut quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![1, 2, 3],
            vec![4, 5, 6],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        // Tamper with context after signing.
        quote.context = vec![99, 99, 99];

        let mut signers = BTreeSet::new();
        signers.insert(signer_address);

        let result = quote.verify_signer(&fee_account, 42, &payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_tampered_data_fails() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let mut quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![1, 2, 3],
            vec![4, 5, 6],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        // Tamper with data after signing.
        quote.data = vec![0, 0, 0];

        let mut signers = BTreeSet::new();
        signers.insert(signer_address);

        let result = quote.verify_signer(&fee_account, 42, &payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    #[test]
    fn test_verify_multiple_authorized_signers() {
        let key1 = SigningKey::random(&mut rand::thread_rng());
        let key2 = SigningKey::random(&mut rand::thread_rng());

        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let mut signers = BTreeSet::new();
        signers.insert(eth_address(&key1));
        signers.insert(eth_address(&key2));

        // Quote signed by key1 should pass.
        let quote1 = make_signed_quote(
            &key1,
            &fee_account,
            42,
            &payer,
            vec![1],
            vec![2],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );
        let recovered1 = quote1
            .verify_signer(&fee_account, 42, &payer, &signers)
            .unwrap();
        assert_eq!(recovered1, eth_address(&key1));

        // Quote signed by key2 should also pass.
        let quote2 = make_signed_quote(
            &key2,
            &fee_account,
            42,
            &payer,
            vec![1],
            vec![2],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );
        let recovered2 = quote2
            .verify_signer(&fee_account, 42, &payer, &signers)
            .unwrap();
        assert_eq!(recovered2, eth_address(&key2));
    }

    #[test]
    fn test_verify_removed_signer_fails() {
        let signing_key = SigningKey::random(&mut rand::thread_rng());
        let signer_address = eth_address(&signing_key);

        let fee_account = Pubkey::new_unique();
        let payer = Pubkey::new_unique();

        let quote = make_signed_quote(
            &signing_key,
            &fee_account,
            42,
            &payer,
            vec![],
            vec![],
            [0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 1],
        );

        // Signer was authorized, then removed.
        let mut signers = BTreeSet::new();
        signers.insert(signer_address);
        assert!(quote
            .verify_signer(&fee_account, 42, &payer, &signers)
            .is_ok());

        signers.remove(&signer_address);
        let result = quote.verify_signer(&fee_account, 42, &payer, &signers);
        assert_eq!(result.unwrap_err(), QuoteVerifyError::UnauthorizedSigner);
    }

    // --- Borsh round-trip ---

    #[test]
    fn test_borsh_roundtrip() {
        let quote = SvmSignedQuote {
            context: vec![1, 2, 3, 4],
            data: vec![5, 6, 7, 8],
            issued_at: [0, 0, 0, 0, 0, 42],
            expiry: [0, 0, 0, 0, 0, 100],
            client_salt: H256::random(),
            signature: [0xAB; 65],
        };

        let encoded = borsh::to_vec(&quote).unwrap();
        let decoded: SvmSignedQuote = borsh::from_slice(&encoded).unwrap();
        assert_eq!(quote, decoded);
    }
}
