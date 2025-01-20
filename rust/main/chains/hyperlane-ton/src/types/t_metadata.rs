#[derive(Debug)]
pub struct TMetadata {
    pub origin_merkle_hook: [u8; 32],
    pub root: [u8; 32],
    pub index: u32,
    pub signatures: Vec<(u32, Vec<u8>)>,
}

impl TMetadata {
    pub fn from_bytes(metadata: &[u8]) -> Result<Self, String> {
        if metadata.len() < 100 {
            return Err(format!(
                "Metadata is too short to parse. Length: {}",
                metadata.len()
            ));
        }

        let mut offset = 0;

        // Extract origin_merkle_hook (32 bytes)
        let origin_merkle_hook = metadata[offset..offset + 32]
            .try_into()
            .map_err(|_| "Failed to parse origin_merkle_hook. Expected 32 bytes.".to_string())?;
        offset += 32;

        // Extract root (32 bytes)
        let root = metadata[offset..offset + 32]
            .try_into()
            .map_err(|_| "Failed to parse root. Expected 32 bytes.".to_string())?;
        offset += 32;

        // Extract index (4 bytes)
        let index = u32::from_be_bytes(
            metadata[offset..offset + 4]
                .try_into()
                .map_err(|_| "Failed to parse index. Expected 4 bytes.".to_string())?,
        );
        offset += 4;

        let mut signatures = Vec::new();

        // Handle the remaining 65 bytes as a single signature if no key-value pairs
        if offset + 65 == metadata.len() {
            let signature = metadata[offset..].to_vec();
            signatures.push((0, signature)); // Use 0 as the default key for a single signature
            return Ok(Self {
                origin_merkle_hook,
                root,
                index,
                signatures,
            });
        }

        // Parse signatures if there are multiple entries (key-value pairs)
        while offset + 69 <= metadata.len() {
            // Extract signature key
            let key = u32::from_be_bytes(
                metadata[offset..offset + 4]
                    .try_into()
                    .map_err(|_| "Failed to parse signature key. Expected 4 bytes.".to_string())?,
            );
            offset += 4;

            // Extract signature
            let signature = metadata[offset..offset + 65].to_vec();
            offset += 65;

            signatures.push((key, signature));
        }

        // Check for leftover bytes
        if offset != metadata.len() {
            return Err(format!(
                "Unexpected leftover bytes in metadata: {} bytes",
                metadata.len() - offset
            ));
        }

        Ok(Self {
            origin_merkle_hook,
            root,
            index,
            signatures,
        })
    }
}
