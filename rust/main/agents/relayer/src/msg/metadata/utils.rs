use eyre::Result;
use hyperlane_core::HyperlaneMessage;
use crate::msg::metadata::polymer::polymer::PolymerProofRequest;

/// Magic number prefix for directive messages
/// MAGIC_NUMBER = 0xFAF09B8DEEC3D47AB5A2F9007ED1C8AD83E602B7FDAA1C47589F370CDA6BF2E1
pub const MAGIC_NUMBER: [u8; 32] = [
    0xFA, 0xF0, 0x9B, 0x8D, 0xEE, 0xC3, 0xD4, 0x7A, 0xB5, 0xA2, 0xF9, 0x00, 0x7E, 0xD1, 0xC8, 0xAD,
    0x83, 0xE6, 0x02, 0xB7, 0xFD, 0xAA, 0x1C, 0x47, 0x58, 0x9F, 0x37, 0x0C, 0xDA, 0x6B, 0xF2, 0xE1,
];

/// Directive types
#[derive(Debug, Clone, Copy)]
pub enum DirectiveType {
    /// EVM log directive type
    EVMLog = 0x01,
}

/// Checks if a message is a directive by matching the magic number prefix
/// The format of directive messages is [MAGIC_NUMBER, DIRECTIVE]
/// A magic number prefix followed by a list of directives.
pub fn is_directive(message: &HyperlaneMessage) -> bool {
    // Check if the body starts with '['
    if message.body.is_empty() || message.body[0] != b'[' {
        return false;
    }

    // Skip the '[' character and check the magic number
    if message.body.len() < MAGIC_NUMBER.len() + 1 {
        return false;
    }

    // Compare the magic number bytes
    message.body[1..=MAGIC_NUMBER.len()] == MAGIC_NUMBER
}

/// Parse a HyperlaneMessage body into a PolymerProofRequest
/// [MAGIC_NUMBER,[DIRECTIVE_TYPE,[CHAIN_ID,BLOCK_NUMBER,TX_INDEX,LOG_INDEX]]
/// TODO: Make a flexible parser for different directive types and providers.
pub fn parse_directive_to_polymer_request(message: &HyperlaneMessage) -> Result<PolymerProofRequest> {
    let body = &message.body;
    
    // Check magic number
    if body[0] != b'[' || body[1..=MAGIC_NUMBER.len()] != MAGIC_NUMBER {
        return Err(eyre::eyre!("Invalid magic number"));
    }

    // Parse directive
    let directive = &body[MAGIC_NUMBER.len() + 2..]; // Skip '[', MAGIC_NUMBER, and ','
    let directive_type = directive[0];
    
    if directive_type != DirectiveType::EVMLog as u8 {
        return Err(eyre::eyre!("Unsupported directive type"));
    }

    // Parse args (chain_id, block_number, tx_index, log_index)
    let args_start = 2; // Skip directive type and comma
    let args = &directive[args_start..];
    
    // Check for opening bracket of args
    if args[0] != b'[' {
        return Err(eyre::eyre!("Invalid args format"));
    }

    // Parse each arg, skipping commas
    let mut offset = 1; // Skip opening bracket
    let chain_id = u64::from_be_bytes(args[offset..offset+8].try_into()?);
    offset += 9; // Skip value and comma
    let block_number = u64::from_be_bytes(args[offset..offset+8].try_into()?);
    offset += 9; // Skip value and comma
    let tx_index = u32::from_be_bytes(args[offset..offset+4].try_into()?);
    offset += 5; // Skip value and comma
    let log_index = u32::from_be_bytes(args[offset..offset+4].try_into()?);

    Ok(PolymerProofRequest {
        chain_id,
        block_number,
        tx_index,
        log_index,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::HyperlaneMessage;

    #[test]
    fn test_is_directive() {
        // Create a message with the correct magic number prefix
        let mut valid_body = vec![b'['];
        valid_body.extend_from_slice(&MAGIC_NUMBER);
        valid_body.extend_from_slice(b"some additional data");
        
        let valid_message = HyperlaneMessage {
            version: 0,
            nonce: 0,
            origin: 0,
            sender: [0; 32].into(),
            destination: 0,
            recipient: [0; 32].into(),
            body: valid_body,
        };
        
        assert!(is_directive(&valid_message));

        // Test with incorrect prefix
        let mut invalid_prefix = vec![b'X'];
        invalid_prefix.extend_from_slice(&MAGIC_NUMBER);
        
        let invalid_prefix_message = HyperlaneMessage {
            version: 0,
            nonce: 0,
            origin: 0,
            sender: [0; 32].into(),
            destination: 0,
            recipient: [0; 32].into(),
            body: invalid_prefix,
        };
        
        assert!(!is_directive(&invalid_prefix_message));

        // Test with empty body
        let empty_message = HyperlaneMessage {
            version: 0,
            nonce: 0,
            origin: 0,
            sender: [0; 32].into(),
            destination: 0,
            recipient: [0; 32].into(),
            body: vec![],
        };
        
        assert!(!is_directive(&empty_message));

        // Test with body too short
        let short_message = HyperlaneMessage {
            version: 0,
            nonce: 0,
            origin: 0,
            sender: [0; 32].into(),
            destination: 0,
            recipient: [0; 32].into(),
            body: vec![b'['],
        };
        
        assert!(!is_directive(&short_message));
    }
} 