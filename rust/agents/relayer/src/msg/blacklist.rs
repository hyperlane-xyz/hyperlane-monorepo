use hyperlane_core::HyperlaneMessage;

#[derive(Debug, Clone, Default)]
pub struct AddressBlacklist {
    // A list of addresses that are blocked from being relayed.
    // Addresses are any length to support different address types.
    pub blacklist: Vec<Vec<u8>>,
}

impl AddressBlacklist {
    pub fn new(blacklist: Vec<Vec<u8>>) -> Self {
        Self { blacklist }
    }

    /// Returns true if the message is blocked by the blacklist.
    /// At the moment, this only checks if the sender, recipient, or body of the
    /// message contains any of the blocked addresses.
    pub fn find_blacklisted_address(&self, message: &HyperlaneMessage) -> Option<Vec<u8>> {
        self.blacklist.iter().find_map(|address| {
            if is_subsequence(message.sender.as_bytes(), address)
                || is_subsequence(message.recipient.as_bytes(), address)
                || is_subsequence(&message.body, address)
            {
                // Return the blocked address that was found.
                Some(address.clone())
            } else {
                None
            }
        })
    }
}

/// Returns true if `needle` is a subsequence of `haystack`.
fn is_subsequence<T: PartialEq>(mut haystack: &[T], needle: &[T]) -> bool {
    if needle.is_empty() {
        return true;
    }

    while !haystack.is_empty() {
        if needle.len() > haystack.len() {
            return false;
        }
        if haystack.starts_with(needle) {
            return true;
        }
        haystack = &haystack[1..];
    }
    false
}

#[cfg(test)]
mod test {
    use hyperlane_core::H256;

    use super::*;

    #[test]
    fn test_is_subsequence() {
        assert!(is_subsequence(b"hello", b"hello"));
        assert!(is_subsequence(b"hello", b"he"));
        assert!(is_subsequence(b"hello", b"lo"));
        assert!(is_subsequence(b"hello", b""));
        assert!(is_subsequence(b"hello", b"o"));

        assert!(!is_subsequence(b"hello", b"hello world"));
        assert!(!is_subsequence(b"hello", b"world"));
        assert!(!is_subsequence(b"hello", b"world hello"));
    }

    #[test]
    fn test_is_blocked() {
        let blocked = b"blocked";
        let blocklist = AddressBlacklist::new(vec![blocked.to_vec()]);

        let bytes_with_subsequence = |subsequence: &[u8], index: usize, len: usize| {
            let mut bytes = vec![0; len];
            bytes[index..index + subsequence.len()].copy_from_slice(subsequence);
            bytes
        };

        let h256_with_subsequence = |subsequence: &[u8], index: usize| {
            let bytes = bytes_with_subsequence(subsequence, index, H256::len_bytes());
            H256::from_slice(&bytes)
        };

        // Blocked - sender includes the blocked address
        let message = HyperlaneMessage {
            sender: h256_with_subsequence(blocked, 0),
            ..Default::default()
        };
        assert_eq!(
            blocklist.find_blacklisted_address(&message),
            Some(blocked.to_vec())
        );

        // Blocked - recipient includes the blocked address
        let message = HyperlaneMessage {
            recipient: h256_with_subsequence(blocked, 20),
            ..Default::default()
        };
        assert_eq!(
            blocklist.find_blacklisted_address(&message),
            Some(blocked.to_vec())
        );

        // Blocked - body includes the blocked address
        let message = HyperlaneMessage {
            body: bytes_with_subsequence(blocked, 100 - blocked.len(), 100),
            ..Default::default()
        };
        assert_eq!(
            blocklist.find_blacklisted_address(&message),
            Some(blocked.to_vec())
        );

        // Not blocked - sender, recipient, and body do not include the blocked address
        let message = HyperlaneMessage {
            body: vec![1; 100],
            ..Default::default()
        };
        assert!(blocklist.find_blacklisted_address(&message).is_none());
    }
}
