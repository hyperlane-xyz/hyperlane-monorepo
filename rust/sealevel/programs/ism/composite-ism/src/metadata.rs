/// Aggregation ISM metadata format (EVM-compatible, from AggregationIsmMetadata.sol):
///
/// [N * 8 bytes] ranges: for each sub-ISM, (start: u32 BE, end: u32 BE)
/// [variable]   sub-metadata blobs packed at the given byte offsets
///
/// start == 0 means no metadata is provided for that sub-ISM (skip it).
/// Sub-ISMs with metadata (start > 0) must all verify successfully.
/// The number of sub-ISMs with metadata must be >= the aggregation threshold.
use crate::error::Error;
use hyperlane_core::U256;
use solana_program::program_error::ProgramError;

const RANGE_SIZE: usize = 4;
const ENTRY_SIZE: usize = RANGE_SIZE * 2; // (start: u32, end: u32)

/// Returns the sub-metadata slice for sub-ISM at `index`, or `None` if not provided.
///
/// Mirrors Solidity's `hasMetadata` + `metadataAt` from `AggregationIsmMetadata.sol`.
/// Returns `Err(InvalidMetadata)` if the header is too short or the range is out of bounds.
pub fn sub_metadata_at(metadata: &[u8], index: usize) -> Result<Option<&[u8]>, ProgramError> {
    let offset = index * ENTRY_SIZE;
    let mid = offset + RANGE_SIZE;
    let end_of_header = mid + RANGE_SIZE;

    if metadata.len() < end_of_header {
        return Err(Error::InvalidMetadata.into());
    }

    let start = u32::from_be_bytes(metadata[offset..mid].try_into().unwrap()) as usize;
    let end = u32::from_be_bytes(metadata[mid..end_of_header].try_into().unwrap()) as usize;

    if start == 0 {
        return Ok(None);
    }
    if start > end || end > metadata.len() {
        return Err(Error::InvalidMetadata.into());
    }

    Ok(Some(&metadata[start..end]))
}

/// Parses the big-endian U256 amount from a warp-route message body.
///
/// Warp-route (TokenMessage) layout: `[recipient (32 bytes)][amount (32 bytes)][metadata]`.
/// Returns `None` if the body is too short.
pub(crate) fn parse_routing_amount(body: &[u8]) -> Option<U256> {
    const AMOUNT_OFFSET: usize = 32;
    const AMOUNT_END: usize = 64;
    let bytes: [u8; 32] = body.get(AMOUNT_OFFSET..AMOUNT_END)?.try_into().ok()?;
    Some(U256::from_big_endian(&bytes))
}

#[cfg(test)]
mod test {
    use super::*;
    use hyperlane_core::U256;

    fn encode_ranges(ranges: &[(u32, u32)]) -> Vec<u8> {
        let mut buf = Vec::new();
        for (start, end) in ranges {
            buf.extend_from_slice(&start.to_be_bytes());
            buf.extend_from_slice(&end.to_be_bytes());
        }
        buf
    }

    #[test]
    fn test_sub_metadata_at_all_provided() {
        let sub0 = b"meta0";
        let sub1 = b"metadata1";
        let header_len = 16u32;
        let start0 = header_len;
        let end0 = start0 + sub0.len() as u32;
        let start1 = end0;
        let end1 = start1 + sub1.len() as u32;

        let mut metadata = encode_ranges(&[(start0, end0), (start1, end1)]);
        metadata.extend_from_slice(sub0);
        metadata.extend_from_slice(sub1);

        assert_eq!(sub_metadata_at(&metadata, 0).unwrap(), Some(sub0.as_ref()));
        assert_eq!(sub_metadata_at(&metadata, 1).unwrap(), Some(sub1.as_ref()));
    }

    #[test]
    fn test_sub_metadata_at_some_skipped() {
        let sub1 = b"meta";
        let header_len = 16u32;
        let start1 = header_len;
        let end1 = start1 + sub1.len() as u32;

        let mut metadata = encode_ranges(&[(0, 0), (start1, end1)]);
        metadata.extend_from_slice(sub1);

        assert_eq!(sub_metadata_at(&metadata, 0).unwrap(), None);
        assert_eq!(sub_metadata_at(&metadata, 1).unwrap(), Some(sub1.as_ref()));
    }

    #[test]
    fn test_sub_metadata_at_too_short() {
        let metadata = vec![0u8; 7]; // needs at least 8 bytes for 1 sub-ISM
        assert!(sub_metadata_at(&metadata, 0).is_err());
    }

    #[test]
    fn test_sub_metadata_at_out_of_bounds() {
        let mut metadata = encode_ranges(&[(100, 200)]);
        metadata.extend_from_slice(&[0u8; 4]);
        assert!(sub_metadata_at(&metadata, 0).is_err());
    }

    #[test]
    fn test_parse_routing_amount_exact_body() {
        let mut body = [0u8; 64];
        body[63] = 42; // amount = 42 in the low byte
        let amount = parse_routing_amount(&body).unwrap();
        assert_eq!(amount, U256::from(42u64));
    }

    #[test]
    fn test_parse_routing_amount_body_longer_than_64() {
        let mut body = vec![0u8; 100];
        body[32] = 1; // high byte of amount = 1 << 248
        let amount = parse_routing_amount(&body).unwrap();
        assert_eq!(amount, U256::from(1u64) << 248);
    }

    #[test]
    fn test_parse_routing_amount_body_too_short() {
        assert!(parse_routing_amount(&[0u8; 63]).is_none());
        assert!(parse_routing_amount(&[]).is_none());
    }
}
