/// Aggregation ISM metadata format (EVM-compatible, from AggregationIsmMetadata.sol):
///
/// [N * 8 bytes] ranges: for each sub-ISM, (start: u32 BE, end: u32 BE)
/// [variable]   sub-metadata blobs packed at the given byte offsets
///
/// start == 0 means no metadata is provided for that sub-ISM (skip it).
/// Sub-ISMs with metadata (start > 0) must all verify successfully.
/// The number of sub-ISMs with metadata must be >= the aggregation threshold.
use crate::error::Error;
use solana_program::program_error::ProgramError;

const RANGE_SIZE: usize = 4;
const ENTRY_SIZE: usize = RANGE_SIZE * 2; // (start: u32, end: u32)

/// A byte range [start, end) into the metadata blob.
/// start == 0 indicates no metadata for this sub-ISM.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MetadataRange {
    pub start: u32,
    pub end: u32,
}

impl MetadataRange {
    /// Returns true if metadata is provided for this sub-ISM.
    pub fn has_metadata(self) -> bool {
        self.start > 0
    }
}

/// Parses the ranges header of aggregation metadata for `n` sub-ISMs.
///
/// Returns `Err(InvalidMetadata)` if the metadata is too short or a range is
/// out of bounds.
pub fn parse_aggregation_ranges(
    metadata: &[u8],
    n: usize,
) -> Result<Vec<MetadataRange>, ProgramError> {
    let header_len = n * ENTRY_SIZE;
    if metadata.len() < header_len {
        return Err(Error::InvalidMetadata.into());
    }

    let mut ranges = Vec::with_capacity(n);
    for i in 0..n {
        let offset = i * ENTRY_SIZE;
        let start = u32::from_be_bytes(
            metadata[offset..offset + RANGE_SIZE]
                .try_into()
                .map_err(|_| Error::InvalidMetadata)?,
        );
        let end = u32::from_be_bytes(
            metadata[offset + RANGE_SIZE..offset + ENTRY_SIZE]
                .try_into()
                .map_err(|_| Error::InvalidMetadata)?,
        );

        if start > 0 {
            // Validate the range is within the metadata blob.
            let end_usize = end as usize;
            let start_usize = start as usize;
            if start_usize > end_usize || end_usize > metadata.len() {
                return Err(Error::InvalidMetadata.into());
            }
        }

        ranges.push(MetadataRange { start, end });
    }

    Ok(ranges)
}

/// Extracts the sub-metadata slice for sub-ISM at `index`.
///
/// Callers must ensure `range.has_metadata()` before calling.
pub fn sub_metadata(metadata: &[u8], range: MetadataRange) -> &[u8] {
    &metadata[range.start as usize..range.end as usize]
}

#[cfg(test)]
mod test {
    use super::*;

    fn encode_ranges(ranges: &[(u32, u32)]) -> Vec<u8> {
        let mut buf = Vec::new();
        for (start, end) in ranges {
            buf.extend_from_slice(&start.to_be_bytes());
            buf.extend_from_slice(&end.to_be_bytes());
        }
        buf
    }

    #[test]
    fn test_parse_ranges_all_provided() {
        let sub0 = b"meta0";
        let sub1 = b"metadata1";
        // header is 2 * 8 = 16 bytes
        let header_len = 16u32;
        let start0 = header_len;
        let end0 = start0 + sub0.len() as u32;
        let start1 = end0;
        let end1 = start1 + sub1.len() as u32;

        let mut metadata = encode_ranges(&[(start0, end0), (start1, end1)]);
        metadata.extend_from_slice(sub0);
        metadata.extend_from_slice(sub1);

        let ranges = parse_aggregation_ranges(&metadata, 2).unwrap();
        assert_eq!(
            ranges[0],
            MetadataRange {
                start: start0,
                end: end0
            }
        );
        assert_eq!(
            ranges[1],
            MetadataRange {
                start: start1,
                end: end1
            }
        );
        assert!(ranges[0].has_metadata());
        assert!(ranges[1].has_metadata());
        assert_eq!(sub_metadata(&metadata, ranges[0]), sub0);
        assert_eq!(sub_metadata(&metadata, ranges[1]), sub1);
    }

    #[test]
    fn test_parse_ranges_some_skipped() {
        // Sub-ISM 0 has no metadata (start=0), sub-ISM 1 has metadata.
        let sub1 = b"meta";
        let header_len = 16u32;
        let start1 = header_len;
        let end1 = start1 + sub1.len() as u32;

        let mut metadata = encode_ranges(&[(0, 0), (start1, end1)]);
        metadata.extend_from_slice(sub1);

        let ranges = parse_aggregation_ranges(&metadata, 2).unwrap();
        assert!(!ranges[0].has_metadata());
        assert!(ranges[1].has_metadata());
    }

    #[test]
    fn test_parse_ranges_too_short() {
        let metadata = vec![0u8; 7]; // needs at least 8 bytes for 1 sub-ISM
        assert!(parse_aggregation_ranges(&metadata, 1).is_err());
    }

    #[test]
    fn test_parse_ranges_out_of_bounds() {
        // start points beyond metadata length
        let mut metadata = encode_ranges(&[(100, 200)]);
        metadata.extend_from_slice(&[0u8; 4]);
        assert!(parse_aggregation_ranges(&metadata, 1).is_err());
    }
}
