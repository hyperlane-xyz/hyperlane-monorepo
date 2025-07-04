use ethers::abi::AbiDecode;
use ethers::types::Bytes;
use hex_literal::hex;

// The 4-byte selector for Error(string)
const ERROR_SELECTOR: [u8; 4] = hex!("08c379a0");

/// Decode the revert reason from the return data of a transaction
pub fn decode_revert_reason(return_data: &Bytes) -> Option<String> {
    if return_data.0.len() >= 4 && return_data.0[..4] == ERROR_SELECTOR {
        // It's an Error(string)
        // Skip selector and decode the rest as string
        let data = &return_data.0[4..];

        // Manually decode the ABI-encoded string
        // Equivalent to ethers.js: ethers.utils.defaultAbiCoder.decode(['string'], data)
        match <String as AbiDecode>::decode(data) {
            Ok(reason) => Some(reason),
            Err(_) => None,
        }
    } else {
        None
    }
}
