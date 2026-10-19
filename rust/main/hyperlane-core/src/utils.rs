use eyre::Result;
#[cfg(not(target_os = "solana"))]
use sha3::{Digest, Keccak256};
use std::str::FromStr;

#[cfg(feature = "float")]
use std::time::Duration;

use crate::{KnownHyperlaneDomain, H160, H256, U256};

/// Converts a hex or base58 string to an H256.
pub fn hex_or_base58_or_bech32_to_h256(string: &str) -> Result<H256> {
    let h256 = if string.starts_with("0x") {
        match string.len() {
            66 => H256::from_str(string)?,
            42 => H160::from_str(string)?.into(),
            _ => eyre::bail!("Invalid hex string"),
        }
    } else {
        let bytes = bech32::decode(string);
        if let Ok((_, bytes)) = bytes {
            if bytes.len() > 32 {
                eyre::bail!("Invalid length of bech32 string")
            }
            // We pad bech32 address to be 32 bytes long
            let padded: Vec<u8> = (0..32usize.saturating_sub(bytes.len()))
                .map(|_| 0u8)
                .chain(bytes.iter().cloned())
                .collect();
            H256::from_slice(padded.as_slice())
        } else {
            let bytes = bs58::decode(string).into_vec()?;
            // Tron address
            if bytes.len() == 25 {
                // Drop the first byte (address type) and last 4 bytes (checksum)
                return Ok(H160::from_slice(&bytes[1..21]).into());
            }
            if bytes.len() != 32 {
                eyre::bail!("Invalid length of base58 string")
            }
            H256::from_slice(bytes.as_slice())
        }
    };

    Ok(h256)
}

/// Keccak-256 of the concatenation of `parts`.
///
/// On Sealevel (SBF) this uses the `sol_keccak256` syscall, which costs far
/// fewer compute units than hashing in software. Everywhere else it uses the
/// `sha3` crate.
pub(crate) fn keccak256(parts: &[&[u8]]) -> H256 {
    #[cfg(target_os = "solana")]
    {
        H256(solana_keccak_hasher::hashv(parts).to_bytes())
    }
    #[cfg(not(target_os = "solana"))]
    {
        let mut hasher = Keccak256::new();
        for part in parts {
            hasher.update(part);
        }
        H256::from_slice(hasher.finalize().as_slice())
    }
}

/// Computes hash of domain concatenated with "HYPERLANE"
pub fn domain_hash(address: H256, domain: impl Into<u32>) -> H256 {
    keccak256(&[
        &domain.into().to_be_bytes(),
        address.as_bytes(),
        b"HYPERLANE",
    ])
}

/// Computes hash of domain concatenated with "HYPERLANE_ANNOUNCEMENT"
pub fn announcement_domain_hash(address: H256, domain: impl Into<u32>) -> H256 {
    keccak256(&[
        &domain.into().to_be_bytes(),
        address.as_bytes(),
        b"HYPERLANE_ANNOUNCEMENT",
    ])
}

/// Pretty print an address based on the domain it is for.
pub fn fmt_address_for_domain(domain: u32, addr: H256) -> String {
    KnownHyperlaneDomain::try_from(domain)
        .map(|d| d.domain_protocol().fmt_address(addr))
        .unwrap_or_else(|_| format!("{addr:?}"))
}

/// Pretty print a byte slice, including a hex prefix
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

/// Exponent value for atto units (10^-18).
const ATTO_EXPONENT: u32 = 18;

/// Converts `value` expressed with `decimals` into `atto` (`10^-18`) decimals.
pub fn to_atto(value: U256, decimals: u32) -> Option<U256> {
    assert!(decimals <= ATTO_EXPONENT);
    let exponent = ATTO_EXPONENT.saturating_sub(decimals);
    let coefficient = U256::from(10u128.pow(exponent));
    value.checked_mul(coefficient)
}

/// Format a domain id as a name if it is known or just the number if not.
pub fn fmt_domain(domain: u32) -> String {
    #[cfg(feature = "strum")]
    {
        KnownHyperlaneDomain::try_from(domain)
            .map(|d| d.to_string())
            .unwrap_or_else(|_| domain.to_string())
    }
    #[cfg(not(feature = "strum"))]
    {
        domain.to_string()
    }
}

/// Formats the duration in the most appropriate time units.
#[cfg(feature = "float")]
pub fn fmt_duration(dur: Duration) -> String {
    const MIN: f64 = 60.;
    const HOUR: f64 = MIN * 60.;
    const DAY: f64 = HOUR * 24.;
    const YEAR: f64 = DAY * 365.25;

    let sec = dur.as_secs_f64();
    if sec < 60. {
        format!("{sec:.0}s")
    } else if sec < HOUR {
        format!("{:.1}m", sec / MIN)
    } else if sec < DAY {
        format!("{:.2}h", sec / HOUR)
    } else if sec < YEAR {
        format!("{:.2}d", sec / DAY)
    } else {
        format!("{:.2}y", sec / YEAR)
    }
}

/// Formats the duration in the most appropriate time units and says "synced" if
/// the duration is 0.
#[cfg(feature = "float")]
pub fn fmt_sync_time(dur: Duration) -> String {
    if dur.as_secs() == 0 {
        "synced".into()
    } else {
        fmt_duration(dur)
    }
}

/// Use as `#[serde(with = serde_u128)]` to serialize/deserialize u128s as strings but not break
/// support for numbers.
pub mod serde_u128 {
    use serde::{de, de::Visitor, Deserializer, Serializer};

    struct U128Visitor;

    impl Visitor<'_> for U128Visitor {
        type Value = u128;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or number representing a u128")
        }

        fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
            v.parse::<u128>()
                .map_err(|_| E::custom("failed to parse u128"))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(v as u128)
        }

        fn visit_u128<E: de::Error>(self, v: u128) -> Result<Self::Value, E> {
            Ok(v)
        }
    }

    /// Serialize a u128 as a string.
    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    /// Deserialize a u128 that might be a string or a number.
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        d.deserialize_any(U128Visitor)
    }

    #[cfg(test)]
    mod test {
        #[derive(Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
        struct Test {
            #[serde(with = "super")]
            v: u128,
        }

        #[test]
        fn test_serialize() {
            assert_eq!(
                serde_json::to_string(&Test { v: 0 }).unwrap(),
                r#"{"v":"0"}"#
            );
            assert_eq!(
                serde_json::to_string(&Test { v: 42 }).unwrap(),
                r#"{"v":"42"}"#
            );
            assert_eq!(
                serde_json::to_string(&Test { v: u128::MAX }).unwrap(),
                format!(r#"{{"v":"{}"}}"#, u128::MAX)
            );
        }

        #[test]
        fn test_deserialize_str() {
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":"0"}"#).unwrap(),
                Test { v: 0 }
            );
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":"42"}"#).unwrap(),
                Test { v: 42 }
            );
            assert_eq!(
                serde_json::from_str::<Test>(&format!(r#"{{"v":"{}"}}"#, u128::MAX)).unwrap(),
                Test { v: u128::MAX }
            )
        }

        #[test]
        fn test_deserialize_int() {
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":0}"#).unwrap(),
                Test { v: 0 }
            );
            assert_eq!(
                serde_json::from_str::<Test>(r#"{"v":42}"#).unwrap(),
                Test { v: 42 }
            );
        }
    }
}

/// Unwrap an expression that returns an `Option`, and return `Ok(None)` if it is `None`.
/// Otherwise, assign the value to the given variable name.
/// We use the pattern of returning `Ok(None)` a lot because of our retry logic,
/// and the goal of this macro is to reduce the boilerplate.
/// ```ignore
/// // before using the macro:
/// let Some(idx) = self.index_of_next_key()
/// else {
///     return Ok(None);
/// };
/// // after:
/// let idx = unwrap_or_none_result!(self.index_of_next_key());
/// ```
#[macro_export]
macro_rules! unwrap_or_none_result {
    ($e:expr $(, $else_e:expr)?) => {
        if let Some(inner) = $e {
            inner
        } else {
            $($else_e;)?
            return Ok(None);
        };
    };
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_hex_or_base58_or_bech32_to_h256_tron() {
        // Test Tron address (base58, 25 bytes with type byte and checksum)
        // TRX address example: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t (USDT on Tron)
        let tron_addr = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
        let expected = hex::decode("a614f803b6fd780986a42c78ec9c7f77e6ded13c").unwrap();
        let result = hex_or_base58_or_bech32_to_h256(tron_addr);
        assert!(result.is_ok());

        let h256 = result.unwrap();
        // Should have leading zeros since it's converted from H160
        assert_eq!(&h256.0[0..12], &[0u8; 12]);
        assert_eq!(&h256.0[12..32], &expected);
    }

    fn h256(hex: &str) -> H256 {
        H256::from_str(hex).unwrap()
    }

    #[test]
    fn keccak256_matches_one_shot_digest_of_concatenation() {
        let data: Vec<u8> = (0..600u32).map(|i| (i % 251) as u8).collect();
        // Split points straddle the 136-byte keccak rate, plus empty parts.
        for splits in [
            vec![],
            vec![0],
            vec![1],
            vec![135, 136],
            vec![136, 136, 137],
            vec![32, 64, 272, 599],
        ] {
            let mut parts = vec![];
            let mut start = 0;
            for end in splits {
                parts.push(&data[start..end]);
                start = end;
            }
            parts.push(&data[start..]);
            let expected = H256::from_slice(Keccak256::digest(&data).as_slice());
            assert_eq!(keccak256(&parts), expected);
        }
        assert_eq!(keccak256(&[]), H256::from_slice(&Keccak256::digest([])));
    }

    #[test]
    fn domain_hash_matches_vectors() {
        // vectors/domainHash.json
        let mailbox = h256("0x0000000000000000000000002222222222222222222222222222222222222222");
        for (domain, expected) in [
            (
                1u32,
                "0xbbca56eb98960a4637eb40486d9a069550dd70d9c185ed138516e8e33cf3d7e7",
            ),
            (
                2,
                "0xa6a93d86d397028e41995d521ccbc270e6db2a2fc530dcb7f0135254f30c8424",
            ),
            (
                3,
                "0xffb4fbe5142f55e07b5d44b3c7f565c5ef4b016551cbd7c23a92c91621aca06f",
            ),
        ] {
            assert_eq!(domain_hash(mailbox, domain), h256(expected));
        }
    }

    #[test]
    fn signing_hashes_match_pinned_values() {
        // Pinned from the sha3/tiny-keccak implementation before the keccak256
        // helper was introduced.
        use crate::{Announcement, Checkpoint, CheckpointWithMessageId, Signable};
        let checkpoint = CheckpointWithMessageId {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: H256::repeat_byte(0x22),
                mailbox_domain: 1000,
                root: H256::repeat_byte(0x02),
                index: 1,
            },
            message_id: H256::repeat_byte(0x33),
        };
        assert_eq!(
            checkpoint.signing_hash(),
            h256("0xbcddec5480f35ff007b474914ff96bd36bd3f746181a80913c74ba2f2b68a593")
        );
        assert_eq!(
            checkpoint.eth_signed_message_hash(),
            h256("0xfddea11848c63a261e2a8db54adc979e65383cdc2d23a238aad55f469de768df")
        );
        let announcement = Announcement {
            validator: H160::repeat_byte(0x44),
            mailbox_address: H256::repeat_byte(0x22),
            mailbox_domain: 1000,
            storage_location: "s3://hyperlane-validator-signatures/us-east-1".to_owned(),
        };
        assert_eq!(
            announcement_domain_hash(H256::repeat_byte(0x22), 1000u32),
            h256("0xeb17b345b7d3353757e679c08fcc73f77a0b6a354ec5d889b8b5f20029a96a82")
        );
        assert_eq!(
            announcement.signing_hash(),
            h256("0xdf0ad50eda4d8898bcbca91981ae2f2259ad2c7bf1f5470f2c5d2a7fbbc1ab41")
        );
        assert_eq!(
            announcement.eth_signed_message_hash(),
            h256("0x8f52fc46d7e098e253f143980b7916eb49098e5798adbcceff5fd92814688530")
        );
    }
}
