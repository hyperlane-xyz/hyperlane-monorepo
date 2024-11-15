use uint::unroll;

use crate::{H256, H512};

/// Creates a big-endian hex representation of the address
pub fn address_to_bytes(data: &H256) -> Vec<u8> {
    if is_h160(data.as_fixed_bytes()) {
        // take the last 20 bytes
        data.as_fixed_bytes()[12..32].into()
    } else {
        h256_to_bytes(data)
    }
}

/// Creates a big-endian hex representation of the address
pub fn bytes_to_address(data: Vec<u8>) -> eyre::Result<H256> {
    if (data.len() != 20) && (data.len() != 32) {
        return Err(eyre::eyre!("Invalid address length"));
    }
    if data.len() == 20 {
        let mut prefix = vec![0; 12];
        prefix.extend(data);
        Ok(H256::from_slice(&prefix[..]))
    } else {
        Ok(H256::from_slice(&data[..]))
    }
}

/// Creates a big-endian hex representation of the address hash
pub fn h256_to_bytes(data: &H256) -> Vec<u8> {
    data.as_fixed_bytes().as_slice().into()
}

/// Creates a big-endian hex representation of the address hash
pub fn h512_to_bytes(data: &H512) -> Vec<u8> {
    if is_h256(data.as_fixed_bytes()) {
        // take the last 32 bytes
        data.as_fixed_bytes()[32..64].into()
    } else {
        data.as_fixed_bytes().as_slice().into()
    }
}

/// Convert bytes into H512 with padding
pub fn bytes_to_h512(data: &[u8]) -> H512 {
    assert!(data.len() <= 64);

    if data.len() == 64 {
        return H512::from_slice(data);
    }

    let mut buf = [0; 64];
    buf[64 - data.len()..64].copy_from_slice(data);

    H512::from_slice(&buf)
}

/// Checks if a byte slice fits within 160 bits. Assumes a big-endian encoding;
/// ignores leading zeros. Current implementation only supports up to a 32 byte
/// array but this could easily be extended if needed.
pub const fn is_h160<const S: usize>(data: &[u8; S]) -> bool {
    assert!(S <= 32);
    if S <= 20 {
        true
    } else {
        let mut z = data[0];
        unroll! {
            for i in 0..11 {
                if S >= i + 22 {
                    z |= data[i + 1]
                }
            }
        }

        z == 0
    }
}

/// Checks if a byte slice fits within 32 bytes. Assumes a big-endian encoding;
/// ignores leading zeros. Current implementation only supports up to a 64 byte long
/// array but this could easily be extended if needed.
pub const fn is_h256<const S: usize>(data: &[u8; S]) -> bool {
    assert!(S <= 64);
    if S <= 32 {
        true
    } else {
        unroll! {
            for i in 0..32 {
                if data[i] != 0 {
                    return false;
                }
            }
        }

        true
    }
}

#[cfg(test)]
mod test {
    #[test]
    fn is_h160() {
        let v: [u8; 32] = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfa, 0xd1,
            0xc9, 0x44, 0x69, 0x70, 0x08, 0x33, 0x71, 0x7f, 0xa8, 0xa3, 0x01, 0x72, 0x78, 0xbc,
            0x1c, 0xa8, 0x03, 0x1c,
        ];
        assert!(super::is_h160(&v));

        let v: [u8; 32] = [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfa, 0xd1,
            0xc9, 0x44, 0x69, 0x70, 0x08, 0x33, 0x71, 0x7f, 0xa8, 0xa3, 0x01, 0x72, 0x78, 0xbc,
            0x1c, 0xa8, 0x03, 0x1c,
        ];
        assert!(!super::is_h160(&v));
    }

    #[test]
    fn is_h256() {
        let v: [u8; 64] = [
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0xfa, 0xd1,
            0xc9, 0x44, 0x69, 0x70, 0x08, 0x33, 0x71, 0x7f, 0xa8, 0xa3, 0x01, 0x72, 0x78, 0xbc,
            0x1c, 0xa8, 0x03, 0x1c, 0x04, 0x1d, 0x05, 0x1e,
        ];
        assert!(super::is_h256(&v));

        let v: [u8; 64] = [
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0xfa, 0xd1,
            0xc9, 0x44, 0x69, 0x70, 0x08, 0x33, 0x71, 0x7f, 0xa8, 0xa3, 0x01, 0x72, 0x78, 0xbc,
            0x1c, 0xa8, 0x03, 0x1c, 0x04, 0x1d, 0x05, 0x1e,
        ];
        assert!(!super::is_h256(&v));
    }
}
