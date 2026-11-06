//! Minimal C ABI around the production Rust regex engine. This library owns no
//! agent state; matching semantics stay entirely in Rust's regex 1.10.6.
use std::os::raw::{c_int, c_uchar};

use regex::Regex;

#[no_mangle]
pub extern "C" fn ziggy_regex_abi_version() -> u32 {
    1
}

/// `out` receives a NUL-terminated compiler diagnostic. `-1` is an invalid
/// pattern, `-2` a pattern/error-buffer size failure, and `-3` a subject too
/// large. No pattern or subject bytes are logged.
///
/// # Safety
/// All pointers must be valid for the documented lengths for the call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_regex_new(
    pattern: *const u8,
    pattern_len: usize,
    error: *mut u8,
    error_len: usize,
    out: *mut *mut Regex,
) -> c_int {
    let Some(pattern) = slice(pattern, pattern_len) else {
        return -2;
    };
    if error.is_null() || error_len == 0 || out.is_null() {
        return -2;
    }
    *out = std::ptr::null_mut();
    let text = match std::str::from_utf8(pattern) {
        Ok(text) => text,
        Err(_) => {
            write_error(
                unsafe { std::slice::from_raw_parts_mut(error, error_len) },
                "regex pattern must be valid UTF-8",
            );
            return -1;
        }
    };
    match Regex::new(text) {
        Ok(regex) => {
            *out = Box::into_raw(Box::new(regex));
            0
        }
        Err(err) => {
            write_error(
                unsafe { std::slice::from_raw_parts_mut(error, error_len) },
                &err.to_string(),
            );
            -1
        }
    }
}

/// Returns 0 and sets `matched` to 0/1. Regex is thread-safe, so the immutable
/// handle may be shared by HotMatcher readers.
///
/// # Safety
/// Pointers must be valid for the call and handle must come from this library.
#[no_mangle]
pub unsafe extern "C" fn ziggy_regex_is_match(
    handle: *mut Regex,
    subject: *const u8,
    subject_len: usize,
    matched: *mut c_uchar,
) -> c_int {
    if handle.is_null() || matched.is_null() {
        return -2;
    }
    let Some(subject) = slice(subject, subject_len) else {
        return -3;
    };
    let text = match std::str::from_utf8(subject) {
        Ok(text) => text,
        Err(_) => {
            // Rust Regex::is_match accepts UTF-8; Hex bodies are always ASCII.
            *matched = 0;
            return 0;
        }
    };
    *matched = u8::from((*handle).is_match(text));
    0
}

/// # Safety
/// Handle must originate from ziggy_regex_new and be freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn ziggy_regex_free(handle: *mut Regex) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle) });
    }
}

unsafe fn slice(pointer: *const u8, len: usize) -> Option<&'static [u8]> {
    if pointer.is_null() {
        return (len == 0).then_some(&[]);
    }
    // Avoid a new allocation; Regex copies/owns what it needs.
    Some(unsafe { std::slice::from_raw_parts(pointer, len) })
}

fn write_error(out: &mut [u8], message: &str) {
    let mut end = out.len().saturating_sub(1).min(message.len());
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    out[..end].copy_from_slice(&message.as_bytes()[..end]);
    out[end] = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c_abi_compiles_and_matches_production_regex() {
        let mut handle = std::ptr::null_mut();
        let mut error = [0u8; 512];
        let pattern = b"^00abff$";
        assert_eq!(
            unsafe {
                ziggy_regex_new(
                    pattern.as_ptr(),
                    pattern.len(),
                    error.as_mut_ptr(),
                    error.len(),
                    &mut handle,
                )
            },
            0
        );
        let mut matched = 0;
        let subject = b"00abff";
        assert_eq!(
            unsafe { ziggy_regex_is_match(handle, subject.as_ptr(), subject.len(), &mut matched) },
            0
        );
        assert_eq!(matched, 1);
        unsafe { ziggy_regex_free(handle) };
    }

    #[test]
    fn invalid_pattern_returns_diagnostic_without_handle() {
        let mut handle = std::ptr::null_mut();
        let mut error = [0u8; 512];
        let pattern = b"(";
        assert_eq!(
            unsafe {
                ziggy_regex_new(
                    pattern.as_ptr(),
                    pattern.len(),
                    error.as_mut_ptr(),
                    error.len(),
                    &mut handle,
                )
            },
            -1
        );
        assert!(handle.is_null());
        assert_ne!(error[0], 0);
    }
}
