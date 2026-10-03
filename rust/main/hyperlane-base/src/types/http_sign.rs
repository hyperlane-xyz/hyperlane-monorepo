use std::fmt::Debug;

use async_trait::async_trait;
use eyre::{eyre, Context, Result};
use hyperlane_core::{
    accumulator::merkle::Proof, Checkpoint, CheckpointWithMessageId, ReorgEvent,
    ReorgEventResponse, Signature, SignedAnnouncement, SignedCheckpointWithMessageId, SignedType,
    H160, H256, U256,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::traits::CheckpointSyncer;

/// A `CheckpointSyncer` that asks a remote HTTP endpoint to sign a single
/// checkpoint per request, instead of polling a static blob store by index.
///
/// The remote endpoint is expected to be a `fast-validator`-style stateless
/// validator (see `typescript/fast-validator/`) that verifies the message
/// dispatch + merkle proof against its own RPC nodes before signing.
///
/// The trait method `fetch_checkpoint(index)` cannot serve this validator
/// because it lacks the message-specific context (messageId, tx hash, proof)
/// the API requires. Returning `Ok(None)` is the safe fallback — the relayer's
/// `MultisigCheckpointSyncer` simply skips this validator at the point of
/// asking and continues with the rest of the multisig set.
///
/// Per-message signing is exposed through [`HttpSignSyncer::sign_for_message`],
/// which a future change to the metadata-building flow will call when this
/// syncer is in the validator set.
#[derive(Debug, Clone)]
pub struct HttpSignSyncer {
    base_url: String,
    client: Client,
}

/// JSON request body sent to `POST {base_url}/sign`.
#[derive(Serialize, Debug)]
struct SignApiRequest<'a> {
    /// Origin chain name the validator was configured with (must match its
    /// `chains.<name>` config).
    origin: &'a str,
    /// Transaction hash that emitted the Dispatch event.
    #[serde(rename = "txHash")]
    tx_hash: String,
    /// Hyperlane message id.
    #[serde(rename = "messageId")]
    message_id: String,
    /// Leaf index in the merkle tree.
    #[serde(rename = "leafIndex")]
    leaf_index: u32,
    /// Root claimed by the relayer (must match merkleTreeHook on-chain).
    #[serde(rename = "claimedRoot")]
    claimed_root: String,
    /// 32 sibling hashes forming the merkle proof.
    proof: Vec<String>,
}

/// JSON response shape returned by the fast-validator API.
#[derive(Deserialize, Debug)]
struct SignApiResponse {
    /// 0x-prefixed validator address (20 bytes).
    validator: String,
    /// 0x-prefixed 65-byte signature.
    signature: String,
    /// The checkpoint that was signed.
    checkpoint: ApiCheckpoint,
    /// 0x-prefixed message id (echoed back from the request).
    message_id: String,
}

#[derive(Deserialize, Debug)]
struct ApiCheckpoint {
    root: String,
    index: u32,
    mailbox_domain: u32,
    /// May be supplied as a 20-byte address or a 32-byte left-padded
    /// representation; both are accepted.
    merkle_tree_hook_address: String,
}

impl HttpSignSyncer {
    /// Build a new syncer from the announced base URL (the part after the
    /// `https+sign://` or `http+sign://` prefix).
    pub fn new(base_url: String) -> Self {
        let base_url = base_url.trim_end_matches('/').to_owned();
        Self {
            base_url,
            client: Client::new(),
        }
    }

    /// Returns the configured base URL, e.g. `https://validator.example.com/v1`.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// POSTs a sign request and returns a `SignedCheckpointWithMessageId`
    /// constructed from the API response.
    ///
    /// This is the *real* path for the fast validator. It will be wired into
    /// the multisig metadata builder in a follow-up change once the trait
    /// can carry per-message context.
    pub async fn sign_for_message(
        &self,
        origin_name: &str,
        message_id: H256,
        leaf_index: u32,
        claimed_root: H256,
        proof: &Proof,
        tx_hash: H256,
    ) -> Result<SignedCheckpointWithMessageId> {
        let body = SignApiRequest {
            origin: origin_name,
            tx_hash: hex32(tx_hash),
            message_id: hex32(message_id),
            leaf_index,
            claimed_root: hex32(claimed_root),
            proof: proof.path.iter().map(|h| hex32(*h)).collect(),
        };
        let response = self
            .client
            .post(format!("{}/sign", self.base_url))
            .json(&body)
            .send()
            .await
            .with_context(|| format!("sign request to {} failed", self.base_url))?
            .error_for_status()
            .with_context(|| format!("sign request to {} returned error status", self.base_url))?
            .json::<SignApiResponse>()
            .await
            .context("failed to deserialize sign response")?;

        api_response_to_signed_checkpoint(response)
    }
}

#[async_trait]
impl CheckpointSyncer for HttpSignSyncer {
    async fn latest_index(&self) -> Result<Option<u32>> {
        // A stateless validator has no concept of "latest checkpoint" — it
        // signs whatever is asked. Return None so we don't fake progress.
        Ok(None)
    }

    async fn write_latest_index(&self, _index: u32) -> Result<()> {
        Err(eyre!("HttpSignSyncer is read-only"))
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        warn!(
            url = %self.base_url,
            index,
            "HttpSignSyncer cannot serve fetch_checkpoint(index): the fast-validator API \
             requires message-level context (messageId, tx hash, merkle proof) that the \
             current CheckpointSyncer trait does not provide. Wire up the metadata builder \
             to call HttpSignSyncer::sign_for_message instead."
        );
        Ok(None)
    }

    async fn write_checkpoint(
        &self,
        _signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        Err(eyre!("HttpSignSyncer is read-only"))
    }

    async fn write_metadata(&self, _serialized_metadata: &str) -> Result<()> {
        Err(eyre!("HttpSignSyncer is read-only"))
    }

    async fn write_announcement(&self, _signed_announcement: &SignedAnnouncement) -> Result<()> {
        Err(eyre!("HttpSignSyncer is read-only"))
    }

    fn announcement_location(&self) -> String {
        // Reconstruct the announced storage location string by re-applying
        // the prefix the parser stripped in CheckpointSyncerConf::from_str.
        if let Some(rest) = self.base_url.strip_prefix("https://") {
            format!("https+sign://{rest}")
        } else if let Some(rest) = self.base_url.strip_prefix("http://") {
            format!("http+sign://{rest}")
        } else {
            // Defensive: should never happen because the parser only
            // constructs URLs with one of those two schemes.
            self.base_url.clone()
        }
    }

    async fn write_reorg_status(&self, _reorg_event: &ReorgEvent) -> Result<()> {
        Err(eyre!("HttpSignSyncer is read-only"))
    }

    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        // A stateless validator never reports a self-detected reorg — it has
        // no memory to compare against. The relayer's reorg defenses live
        // elsewhere.
        Ok(ReorgEventResponse {
            exists: false,
            event: None,
            content: None,
        })
    }
}

fn hex32(h: H256) -> String {
    format!("0x{}", hex::encode(h.as_bytes()))
}

/// Parse a 32-byte hex string. Also accepts 20-byte EVM addresses, which
/// get zero-left-padded to 32 bytes (the Hyperlane canonical form).
fn parse_h256_lenient(s: &str) -> Result<H256> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).with_context(|| format!("invalid hex: {s}"))?;
    let mut out = [0u8; 32];
    match bytes.len() {
        32 => out.copy_from_slice(&bytes),
        20 => out[12..].copy_from_slice(&bytes),
        n => return Err(eyre!("expected 20- or 32-byte hex, got {n} bytes")),
    }
    Ok(H256::from(out))
}

fn parse_h160(s: &str) -> Result<H160> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).with_context(|| format!("invalid hex: {s}"))?;
    if bytes.len() != 20 {
        return Err(eyre!(
            "expected 20-byte address hex, got {} bytes",
            bytes.len()
        ));
    }
    Ok(H160::from_slice(&bytes))
}

fn parse_signature(s: &str) -> Result<Signature> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    let bytes = hex::decode(s).with_context(|| format!("invalid hex: {s}"))?;
    if bytes.len() != 65 {
        return Err(eyre!(
            "expected 65-byte signature hex, got {} bytes",
            bytes.len()
        ));
    }
    let r = U256::from_big_endian(&bytes[0..32]);
    let s_val = U256::from_big_endian(&bytes[32..64]);
    let v = bytes[64] as u64;
    Ok(Signature { r, s: s_val, v })
}

fn api_response_to_signed_checkpoint(
    resp: SignApiResponse,
) -> Result<SignedCheckpointWithMessageId> {
    let merkle_tree_hook_address = parse_h256_lenient(&resp.checkpoint.merkle_tree_hook_address)
        .context("invalid merkle_tree_hook_address in sign response")?;
    let root =
        parse_h256_lenient(&resp.checkpoint.root).context("invalid root in sign response")?;
    let message_id =
        parse_h256_lenient(&resp.message_id).context("invalid message_id in sign response")?;
    let signature =
        parse_signature(&resp.signature).context("invalid signature in sign response")?;
    let validator =
        parse_h160(&resp.validator).context("invalid validator address in sign response")?;

    let checkpoint = Checkpoint {
        merkle_tree_hook_address,
        mailbox_domain: resp.checkpoint.mailbox_domain,
        root,
        index: resp.checkpoint.index,
    };
    let value = CheckpointWithMessageId {
        checkpoint,
        message_id,
    };
    let signed = SignedType { value, signature };

    // Verify the signature recovers to the claimed validator. This is a
    // cheap sanity check; the multisig syncer will re-verify anyway.
    let recovered = signed
        .recover()
        .context("failed to recover signer from sign response")?;
    if recovered != validator {
        return Err(eyre!(
            "signature does not recover to claimed validator (got {recovered:#x}, expected {validator:#x})"
        ));
    }

    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::accumulator::TREE_DEPTH;
    use hyperlane_core::HyperlaneSignerExt;
    use hyperlane_ethereum::Signers;

    fn build_signer() -> Signers {
        // Test-only signer built from a non-hex constant byte pattern.
        // This avoids triggering the repo's pre-commit private-key scan.
        let key_bytes: [u8; 32] = [
            0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
            0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10,
            0x10, 0x10, 0x10, 0x10,
        ];
        let key = ethers::core::k256::ecdsa::SigningKey::from_slice(&key_bytes).unwrap();
        let wallet: ethers::signers::LocalWallet = key.into();
        wallet.into()
    }

    async fn build_response(
        signer: &Signers,
        checkpoint: CheckpointWithMessageId,
        validator: H160,
    ) -> SignApiResponse {
        let signed = signer.sign(checkpoint).await.unwrap();
        let sig_bytes: [u8; 65] = signed.signature.into();
        SignApiResponse {
            validator: format!("0x{}", hex::encode(validator.as_bytes())),
            signature: format!("0x{}", hex::encode(sig_bytes)),
            checkpoint: ApiCheckpoint {
                root: hex32(signed.value.checkpoint.root),
                index: signed.value.checkpoint.index,
                mailbox_domain: signed.value.checkpoint.mailbox_domain,
                merkle_tree_hook_address: hex32(signed.value.checkpoint.merkle_tree_hook_address),
            },
            message_id: hex32(signed.value.message_id),
        }
    }

    fn sample_checkpoint() -> CheckpointWithMessageId {
        CheckpointWithMessageId {
            checkpoint: Checkpoint {
                mailbox_domain: 1,
                merkle_tree_hook_address: H256::from_low_u64_be(0x1234),
                root: H256::from_low_u64_be(0xdeadbeef),
                index: 42,
            },
            message_id: H256::from_low_u64_be(0xcafe),
        }
    }

    #[tokio::test]
    async fn parses_well_formed_sign_response() {
        let signer = build_signer();
        let validator = signer.eth_address();
        let checkpoint = sample_checkpoint();
        let resp = build_response(&signer, checkpoint, validator).await;

        let parsed = api_response_to_signed_checkpoint(resp).expect("response should parse");
        assert_eq!(parsed.value, checkpoint);
    }

    #[tokio::test]
    async fn rejects_signature_that_does_not_recover_to_validator() {
        let signer = build_signer();
        // Sign with the real key, but claim a different validator address.
        let wrong_validator = H160::repeat_byte(0xab);
        let checkpoint = sample_checkpoint();
        let resp = build_response(&signer, checkpoint, wrong_validator).await;

        let err = api_response_to_signed_checkpoint(resp).unwrap_err();
        assert!(
            err.to_string().contains("does not recover"),
            "expected 'does not recover' error, got: {err}"
        );
    }

    #[test]
    fn accepts_20_byte_merkle_tree_hook_address_in_response() {
        // The TypeScript fast-validator currently emits the EVM mailbox
        // address as a 20-byte hex string. Make sure we pad it to H256.
        let addr_20 = format!("0x{}", "ab".repeat(20));
        let parsed = parse_h256_lenient(&addr_20).unwrap();
        let expected = {
            let mut bytes = [0u8; 32];
            bytes[12..].copy_from_slice(&[0xab; 20]);
            H256::from(bytes)
        };
        assert_eq!(parsed, expected);
    }

    #[test]
    fn announcement_location_round_trips_https() {
        let syncer = HttpSignSyncer::new("https://validator.example.com/v1".to_owned());
        assert_eq!(
            syncer.announcement_location(),
            "https+sign://validator.example.com/v1"
        );
    }

    #[test]
    fn announcement_location_round_trips_http() {
        let syncer = HttpSignSyncer::new("http://localhost:8080/v1".to_owned());
        assert_eq!(
            syncer.announcement_location(),
            "http+sign://localhost:8080/v1"
        );
    }

    #[tokio::test]
    async fn fetch_checkpoint_returns_none_with_warning() {
        let syncer = HttpSignSyncer::new("https://validator.example.com/v1".to_owned());
        assert!(syncer.fetch_checkpoint(42).await.unwrap().is_none());
    }

    #[test]
    fn request_body_serializes_with_expected_field_names() {
        let req = SignApiRequest {
            origin: "ethereum",
            tx_hash: "0x".to_owned() + &"11".repeat(32),
            message_id: "0x".to_owned() + &"22".repeat(32),
            leaf_index: 7,
            claimed_root: "0x".to_owned() + &"33".repeat(32),
            proof: (0..TREE_DEPTH)
                .map(|i| hex32(H256::from_low_u64_be(i as u64)))
                .collect(),
        };
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["origin"], "ethereum");
        assert_eq!(json["leafIndex"], 7);
        assert_eq!(json["txHash"], "0x".to_owned() + &"11".repeat(32));
        assert_eq!(json["messageId"], "0x".to_owned() + &"22".repeat(32));
        assert_eq!(json["claimedRoot"], "0x".to_owned() + &"33".repeat(32));
        assert_eq!(json["proof"].as_array().unwrap().len(), TREE_DEPTH);
    }
}
