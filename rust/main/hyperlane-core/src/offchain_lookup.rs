//! The existing EIP-191 offchain lookup authentication payload.

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

#[cfg(test)]
mod tests {
    use super::*;

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
