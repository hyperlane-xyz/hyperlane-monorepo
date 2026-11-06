//! Public-value primitives from the exact production-pinned snarkVM revision.
//! No RPC, VM orchestration, credentials, secret input, logging or custom crypto.
use snarkvm_console_account::{Address, FromBytes, ToBits, ToBytes};
use snarkvm_console_network::{MainnetV0, Network};
use snarkvm_console_program::{Identifier, Plaintext, ProgramID};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    str::FromStr,
};

type N = MainnetV0;
fn checked(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(_) => -3,
    }
}
unsafe fn text<'a>(ptr: *const u8, len: usize) -> Result<&'a str, i32> {
    if ptr.is_null() || len == 0 || len > 1_048_576 {
        return Err(-1);
    }
    std::str::from_utf8(std::slice::from_raw_parts(ptr, len)).map_err(|_| -2)
}
unsafe fn write(
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
    bytes: &[u8],
) -> Result<(), i32> {
    if out.is_null() || written.is_null() {
        return Err(-1);
    }
    *written = bytes.len();
    if capacity < bytes.len() {
        return Err(-4);
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
    Ok(())
}
#[no_mangle]
pub extern "C" fn ziggy_aleo_crypto_abi_version() -> u32 {
    1
}
/// Parse a canonical Aleo address and return the 32 compressed little-endian bytes.
/// # Safety
/// Valid live nonoverlapping buffers of declared size are required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_address_decode(
    input: *const u8,
    len: usize,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let value = Address::<N>::from_str(text(input, len)?).map_err(|_| -2)?;
        let bytes = value.to_bytes_le().map_err(|_| -2)?;
        if bytes.len() != 32 {
            return Err(-2);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
        Ok(())
    })
}
/// Address bytes to canonical Bech32m text. Output buffer at least 63 bytes.
/// # Safety
/// Valid live nonoverlapping buffers of declared size are required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_address_encode(
    input: *const u8,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    checked(|| {
        if input.is_null() {
            return Err(-1);
        }
        let bytes = std::slice::from_raw_parts(input, 32);
        let value = Address::<N>::from_bytes_le(bytes).map_err(|_| -2)?;
        if value.to_bytes_le().map_err(|_| -2)? != bytes {
            return Err(-2);
        }
        write(out, capacity, written, value.to_string().as_bytes())
    })
}
/// ProgramID to compressed address using the source network primitive.
/// # Safety
/// Valid live nonoverlapping buffers of declared size are required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_program_address(
    input: *const u8,
    len: usize,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let program = ProgramID::<N>::from_str(text(input, len)?).map_err(|_| -2)?;
        let bytes = program
            .to_address()
            .map_err(|_| -2)?
            .to_bytes_le()
            .map_err(|_| -2)?;
        if bytes.len() != 32 {
            return Err(-2);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
        Ok(())
    })
}
/// Mapping key ID uses exact source bit preimage with separator bits and BHP1024.
/// # Safety
/// All inputs must be live text buffers, and output must hold 32 nonoverlapping bytes.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_mapping_key_id(
    program: *const u8,
    program_len: usize,
    mapping: *const u8,
    mapping_len: usize,
    key: *const u8,
    key_len: usize,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let program = ProgramID::<N>::from_str(text(program, program_len)?).map_err(|_| -2)?;
        let mapping = Identifier::<N>::from_str(text(mapping, mapping_len)?).map_err(|_| -2)?;
        let key = Plaintext::<N>::from_str(text(key, key_len)?).map_err(|_| -2)?;
        let mut bits = Vec::new();
        program.write_bits_le(&mut bits);
        false.write_bits_le(&mut bits);
        mapping.write_bits_le(&mut bits);
        false.write_bits_le(&mut bits);
        key.write_bits_le(&mut bits);
        let bytes = N::hash_bhp1024(&bits)
            .map_err(|_| -2)?
            .to_bytes_le()
            .map_err(|_| -2)?;
        if bytes.len() != 32 {
            return Err(-2);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
        Ok(())
    })
}

/// Parse a source-network block/transaction/transition ID to its 32 little-endian bytes.
/// # Safety
/// Input must be a live text buffer; output must hold 32 nonoverlapping bytes.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_id_decode(
    kind: u32,
    input: *const u8,
    len: usize,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let text = text(input, len)?;
        let bytes = match kind {
            0 => <N as Network>::BlockHash::from_str(text)
                .map_err(|_| -2)?
                .to_bytes_le()
                .map_err(|_| -2)?,
            1 => <N as Network>::TransactionID::from_str(text)
                .map_err(|_| -2)?
                .to_bytes_le()
                .map_err(|_| -2)?,
            2 => <N as Network>::TransitionID::from_str(text)
                .map_err(|_| -2)?
                .to_bytes_le()
                .map_err(|_| -2)?,
            _ => return Err(-1),
        };
        if bytes.len() != 32 {
            return Err(-2);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
        Ok(())
    })
}

/// Encode canonical compressed block/transaction/transition ID bytes.
/// # Safety
/// Live32-byte input and nonoverlapping output/length buffers are required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_id_encode(
    kind: u32,
    input: *const u8,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    checked(|| {
        if input.is_null() {
            return Err(-1);
        }
        let bytes = std::slice::from_raw_parts(input, 32);
        let (encoded, canonical) = match kind {
            0 => {
                let value = <N as Network>::BlockHash::from_bytes_le(bytes).map_err(|_| -2)?;
                (value.to_string(), value.to_bytes_le().map_err(|_| -2)?)
            }
            1 => {
                let value = <N as Network>::TransactionID::from_bytes_le(bytes).map_err(|_| -2)?;
                (value.to_string(), value.to_bytes_le().map_err(|_| -2)?)
            }
            2 => {
                let value = <N as Network>::TransitionID::from_bytes_le(bytes).map_err(|_| -2)?;
                (value.to_string(), value.to_bytes_le().map_err(|_| -2)?)
            }
            _ => return Err(-1),
        };
        if canonical != bytes {
            return Err(-2);
        }
        write(out, capacity, written, encoded.as_bytes())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_program_roundtrip_and_mapping_boundaries() {
        let program = b"credits.aleo";
        let mut address = [0u8; 32];
        assert_eq!(
            unsafe {
                ziggy_aleo_program_address(program.as_ptr(), program.len(), address.as_mut_ptr())
            },
            0
        );
        let mut encoded = [0u8; 128];
        let mut len = 0;
        assert_eq!(
            unsafe {
                ziggy_aleo_address_encode(
                    address.as_ptr(),
                    encoded.as_mut_ptr(),
                    encoded.len(),
                    &mut len,
                )
            },
            0
        );
        let mut decoded = [0u8; 32];
        assert_eq!(
            unsafe { ziggy_aleo_address_decode(encoded.as_ptr(), len, decoded.as_mut_ptr()) },
            0
        );
        assert_eq!(address, decoded);
        assert_eq!(
            unsafe { ziggy_aleo_program_address(std::ptr::null(), 0, address.as_mut_ptr()) },
            -1
        );
        assert_eq!(
            unsafe { ziggy_aleo_program_address(b"bad".as_ptr(), 3, address.as_mut_ptr()) },
            -2
        );
    }
}
