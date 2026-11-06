//! Primitive-only C boundary to the production-pinned cryptography libraries.
//! No network, credentials, transaction policy, logging or agent runtime.
use starknet_crypto::{get_public_key, pedersen_hash, poseidon_hash_many, verify, Felt};
use std::panic::{catch_unwind, AssertUnwindSafe};
use zeroize::Zeroizing;

// All public byte arrays are fixed-width big endian. Callers provide valid,
// live buffers of the documented sizes, as for any native C buffer API.
unsafe fn felt(input: *const u8) -> Result<Felt, i32> {
    if input.is_null() {
        return Err(-1);
    }
    let bytes = &*(input as *const [u8; 32]);
    let value = Felt::from_bytes_be(bytes);
    if value.to_bytes_be() != *bytes {
        return Err(-2);
    }
    Ok(value)
}
unsafe fn output(pointer: *mut u8, bytes: &[u8]) -> Result<(), i32> {
    if pointer.is_null() {
        return Err(-1);
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len());
    Ok(())
}
fn checked(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(_) => -3,
    }
}
fn key(value: Felt) -> Result<Zeroizing<Felt>, i32> {
    if value == Felt::ZERO || value >= starknet_curve::curve_params::EC_ORDER {
        return Err(-2);
    }
    Ok(Zeroizing::new(value))
}

#[no_mangle]
pub extern "C" fn ziggy_starknet_crypto_abi_version() -> u32 {
    1
}

/// Pedersen(left32, right32) -> hash32. Buffers must not overlap.
///
/// # Safety
/// Input and output pointers must reference valid, nonoverlapping buffers of
/// the documented sizes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_starknet_pedersen(
    left: *const u8,
    right: *const u8,
    out: *mut u8,
) -> i32 {
    checked(|| {
        output(
            out,
            &pedersen_hash(&felt(left)?, &felt(right)?).to_bytes_be(),
        )
    })
}
/// Poseidon over count concatenated 32-byte felts -> hash32. Count <= 1M.
///
/// # Safety
/// Input and output pointers must reference valid, nonoverlapping buffers of
/// the documented sizes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_starknet_poseidon(
    input: *const u8,
    count: usize,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if count > 1_000_000 || (input.is_null() && count != 0) {
            return Err(-1);
        }
        let mut values = Vec::with_capacity(count);
        for i in 0..count {
            values.push(felt(input.add(i * 32))?);
        }
        output(out, &poseidon_hash_many(&values).to_bytes_be())
    })
}
/// Secret scalar32 -> public x-coordinate32. Secret is never formatted/logged.
///
/// # Safety
/// Input and output pointers must reference valid, nonoverlapping buffers of
/// the documented sizes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_starknet_public_key(secret: *const u8, out: *mut u8) -> i32 {
    checked(|| {
        let secret = key(felt(secret)?)?;
        output(out, &get_public_key(&secret).to_bytes_be())
    })
}
/// Production high-level RFC6979 ECDSA, including its canonical seed retry.
/// Secret32 + hash32 -> concatenated r32/s32. No caller-supplied nonce interface.
///
/// # Safety
/// Input and output pointers must reference valid, nonoverlapping buffers of
/// the documented sizes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_starknet_sign(
    secret: *const u8,
    hash: *const u8,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let secret = key(felt(secret)?)?;
        let signature = starknet_core::crypto::ecdsa_sign(&secret, &felt(hash)?).map_err(|_| -3)?;
        output(out, &signature.r.to_bytes_be())?;
        output(out.add(32), &signature.s.to_bytes_be())
    })
}
/// Public32 + hash32 + r32/s32 -> byte 0/1. Errors produce no valid result.
///
/// # Safety
/// Input and output pointers must reference valid, nonoverlapping buffers of
/// the documented sizes for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_starknet_verify(
    public: *const u8,
    hash: *const u8,
    signature: *const u8,
    out: *mut u8,
) -> i32 {
    checked(|| {
        if signature.is_null() || out.is_null() {
            return Err(-1);
        }
        let valid = verify(
            &felt(public)?,
            &felt(hash)?,
            &felt(signature)?,
            &felt(signature.add(32))?,
        )
        .map_err(|_| -3)?;
        output(out, &[u8::from(valid)])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ffi_validates_null_field_scalar_signing_and_verification() {
        let mut out = [0u8; 64];
        unsafe {
            assert_eq!(
                ziggy_starknet_public_key(std::ptr::null(), out.as_mut_ptr()),
                -1
            );
            assert_eq!(
                ziggy_starknet_public_key([0; 32].as_ptr(), out.as_mut_ptr()),
                -2
            );
            assert_eq!(
                ziggy_starknet_public_key([255; 32].as_ptr(), out.as_mut_ptr()),
                -2
            );
            let mut secret = [0; 32];
            secret[31] = 17;
            let mut hash = [0; 32];
            hash[31] = 42;
            let mut public = [0; 32];
            assert_eq!(
                ziggy_starknet_public_key(secret.as_ptr(), public.as_mut_ptr()),
                0
            );
            assert_eq!(
                ziggy_starknet_sign(secret.as_ptr(), hash.as_ptr(), out.as_mut_ptr()),
                0
            );
            let mut valid = 0;
            assert_eq!(
                ziggy_starknet_verify(public.as_ptr(), hash.as_ptr(), out.as_ptr(), &mut valid),
                0
            );
            assert_eq!(valid, 1);
            hash[31] ^= 1;
            assert_eq!(
                ziggy_starknet_verify(public.as_ptr(), hash.as_ptr(), out.as_ptr(), &mut valid),
                0
            );
            assert_eq!(valid, 0);
        }
    }
}
