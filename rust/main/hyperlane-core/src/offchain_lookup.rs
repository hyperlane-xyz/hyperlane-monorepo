//! EIP-191 offchain lookup authentication payloads.
//!
//! - v1 (packed): `keccak256(tag ‖ sender ‖ callData ‖ url)`. Still signed by
//!   the Sealevel CCS reader.
//! - v2 (framed): one ABI word per field, binding the request to the message
//!   being delivered, its origin transaction and the time it was signed.

use sha3::{digest::Update, Digest, Keccak256};
use tiny_keccak::{Hasher, Keccak};

use crate::{utils::bytes_to_hex, HyperlaneSigner, HyperlaneSignerError, H160, H256};

/// Hash packed domain tag, sender, calldata, and public URL template.
/// Sign this hash using `HyperlaneSigner::sign_hash` (EIP-191).
pub fn offchain_lookup_request_message_hash(sender: H160, data: &[u8], url: &[u8]) -> H256 {
    let mut hasher = Keccak::v256();
    hasher.update(b"HYPERLANE_OFFCHAINLOOKUP");
    hasher.update(sender.as_bytes());
    hasher.update(data);
    hasher.update(url);
    let mut hash = [0; 32];
    hasher.finalize(&mut hash);
    hash.into()
}

/// Sign the existing offchain lookup payload and encode its EIP-191 signature.
/// Shared by EVM CCIP-read POSTs and Sealevel CCS GETs.
pub async fn sign_offchain_lookup(
    signer: &dyn HyperlaneSigner,
    sender: H160,
    data: &[u8],
    url: &[u8],
) -> Result<String, HyperlaneSignerError> {
    let hash = offchain_lookup_request_message_hash(sender, data, url);
    let signature: [u8; 65] = signer.sign_hash(&hash).await?.into();
    Ok(bytes_to_hex(&signature))
}

/// Domain tag of the framed (v2) offchain lookup payload.
pub const OFFCHAIN_LOOKUP_V2_TAG: &[u8] = b"HYPERLANE_OFFCHAINLOOKUP_V2";

/// The fields a framed (v2) offchain lookup signature covers.
#[derive(Clone, Copy, Debug)]
pub struct OffchainLookupRequest<'a> {
    /// Public URL template the request is sent to.
    pub url: &'a [u8],
    /// `OffchainLookup.sender`: the ISM that reverted with the lookup.
    pub sender: H160,
    /// `OffchainLookup.callData`.
    pub call_data: &'a [u8],
    /// Id of the message being delivered. It must come from that message,
    /// never from `call_data`, so a server can check that the lookup describes it.
    pub message_id: H256,
    /// Hash of the transaction that dispatched the message; CCS requires it.
    pub origin_tx_hash: &'a [u8],
    /// Unix seconds at which the request was signed.
    pub issued_at: u64,
}

impl OffchainLookupRequest<'_> {
    /// `keccak256(abi.encode(keccak256(tag), keccak256(url), sender,
    /// keccak256(callData), messageId, keccak256(originTxHash), issuedAt))`.
    ///
    /// The first word is a hash, so no v1 preimage (which starts with the ASCII
    /// tag) is a v2 preimage.
    pub fn signing_hash(&self) -> H256 {
        let mut sender = [0u8; 32];
        sender[12..].copy_from_slice(self.sender.as_bytes());
        let mut issued_at = [0u8; 32];
        issued_at[24..].copy_from_slice(&self.issued_at.to_be_bytes());
        H256::from_slice(
            Keccak256::new()
                .chain(Keccak256::digest(OFFCHAIN_LOOKUP_V2_TAG))
                .chain(Keccak256::digest(self.url))
                .chain(sender)
                .chain(Keccak256::digest(self.call_data))
                .chain(self.message_id)
                .chain(Keccak256::digest(self.origin_tx_hash))
                .chain(issued_at)
                .finalize()
                .as_slice(),
        )
    }

    /// Sign a framed (v2) offchain lookup payload and encode its EIP-191 signature.
    pub async fn sign_offchain_lookup_request(
        &self,
        signer: &dyn HyperlaneSigner,
    ) -> Result<String, HyperlaneSignerError> {
        let signature: [u8; 65] = signer.sign_hash(&self.signing_hash()).await?.into();
        Ok(bytes_to_hex(&signature))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> OffchainLookupRequest<'static> {
        OffchainLookupRequest {
            url: b"https://ccs.example/callCommitments/getCallsFromRevealMessage",
            sender: H160::from([3; 20]),
            call_data: &[0x11; 32],
            message_id: H256::from([0x22; 32]),
            origin_tx_hash: &[0x33; 32],
            issued_at: 1_700_000_000,
        }
    }

    const V2_VECTOR: [u8; 32] = [
        0x8e, 0xf3, 0xfe, 0x80, 0x01, 0x7b, 0x83, 0x4f, 0x4d, 0x5c, 0xbf, 0x46, 0x1f, 0xaa, 0x54,
        0xa6, 0x18, 0x0f, 0xad, 0x62, 0xf4, 0xeb, 0x0c, 0x57, 0x5b, 0xa7, 0x12, 0x67, 0x9f, 0xf5,
        0x1f, 0xfb,
    ];

    #[test]
    fn matches_typescript_lookup_request_hash() {
        // Generated with SDK offchainLookupRequestHash / ethers.utils.defaultAbiCoder.
        assert_eq!(request().signing_hash(), H256::from(V2_VECTOR));
    }

    #[test]
    fn every_field_is_signed() {
        let base = request().signing_hash();
        let other_url = b"https://ccs.example/callCommitments/calldata";
        let changed = [
            OffchainLookupRequest {
                url: other_url,
                ..request()
            },
            OffchainLookupRequest {
                sender: H160::from([4; 20]),
                ..request()
            },
            OffchainLookupRequest {
                call_data: &[0x11; 33],
                ..request()
            },
            OffchainLookupRequest {
                message_id: H256::from([0x23; 32]),
                ..request()
            },
            OffchainLookupRequest {
                origin_tx_hash: &[],
                ..request()
            },
            OffchainLookupRequest {
                issued_at: 1_700_000_001,
                ..request()
            },
        ];
        for request in changed {
            assert_ne!(request.signing_hash(), base, "{request:?}");
        }
    }

    #[test]
    fn bytes_cannot_move_between_call_data_and_url() {
        let url = b"https://ccs.example/a";
        let shifted = OffchainLookupRequest {
            url: &url[1..],
            call_data: &[&[0x11; 32][..], &url[..1]].concat(),
            ..request()
        }
        .signing_hash();
        assert_ne!(
            shifted,
            OffchainLookupRequest { url, ..request() }.signing_hash()
        );
    }

    #[test]
    fn matches_existing_typescript_lookup_hash() {
        // Generated with SDK offchainLookupRequestMessageHash / ethers.solidityKeccak256.
        assert_eq!(
            offchain_lookup_request_message_hash(
                H160::from([3; 20]),
                &[0x11; 32],
                b"https://ccs.example/callCommitments/calldata",
            ),
            H256::from([
                0x8f, 0xd3, 0x0d, 0x2b, 0x31, 0x8f, 0x7c, 0x31, 0xcc, 0x29, 0xcd, 0x3b, 0x14, 0xf5,
                0xfe, 0x89, 0x13, 0x4a, 0x4f, 0x3b, 0x1c, 0xd6, 0x29, 0x56, 0x7d, 0xbb, 0x77, 0x84,
                0x64, 0x63, 0xc9, 0x2b,
            ]),
        );
    }
}
