use color_eyre::Result;
use hyperlane_core::{H160, H256};
use hyperlane_hex as hl_hex;

/// Try to convert a hexadecimal string to H160.
/// Hex string should be 40 characters long, plus optional prefix of "0x".
///
/// # Arguments
/// * `hex_str` - A string slice that holds the hexadecimal encoding.
///
/// # Returns
///
/// * `H160` - Returns H160 if conversion is successful, otherwise returns an Error.
///
/// # Examples
///
/// ```
/// use cli::convert;
///
/// // Successful conversion from str
/// let hex = "0165878A594ca255338adfa4d48449f69242Eb8F";
/// let h160 = convert::try_into_h160_from_hex_str(hex).unwrap();
///
/// let expected_h160 = format!("0x{}", hex.to_lowercase());
/// assert_eq!(format!("{h160:?}"), expected_h160);
///
/// // Successful conversion from String with '0x' prefix
/// let hex = format!("0x{hex}");
/// let h160 = convert::try_into_h160_from_hex_str(&hex).unwrap();
/// assert_eq!(format!("{h160:?}"), expected_h160);
///
/// // Conversion failure due to non-hexadecimal characters
/// let invalid_hex_str = "0xG165878A594ca255338adfa4d48449f69242Eb8F";
/// assert!(convert::try_into_h160_from_hex_str(invalid_hex_str).is_err());
/// ```
pub fn try_into_h160_from_hex_str(hex_str: &str) -> Result<H160> {
    let bytes: &[u8; 40] = hex_str.trim_start_matches("0x").as_bytes().try_into()?;

    let h256: H256 = hl_hex::parse_h256_raw(bytes)?.into();

    Ok(h256.into())
}

pub fn try_into_h256_from_hex_str(hex_str: &str) -> Result<H256> {
    // TODO: Eliminate this function and instead implement FromEtherHex trait?
    // https://docs.rs/ethers/latest/ethers/primitives/trait.FromEtherHex.html
    // See also: https://docs.rs/hex/latest/hex/trait.FromHex.html
    let bytes: &[u8; 64] = hex_str.trim_start_matches("0x").as_bytes().try_into()?;

    Ok(hl_hex::parse_h256_raw(bytes)?.into())
}

pub fn hex_str_to_bytes(hex_str: &str) -> Result<Vec<u8>> {
    Ok(hex::decode(hex_str.trim_start_matches("0x"))?)
}
