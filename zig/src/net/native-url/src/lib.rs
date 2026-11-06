//! Host serialization uses the exact production Rust URL parser. No network,
//! agent state, credential discovery, callbacks or cross-allocator ownership.
use std::panic::{catch_unwind, AssertUnwindSafe};

pub const MAX_INPUT: usize = 16 * 1024 * 1024;
pub const MAX_OUTPUT: usize = MAX_INPUT * 3 + 256;

#[no_mangle]
pub extern "C" fn ziggy_url_abi_version() -> u32 {
    1
}

/// Return the exact `Url::parse(text).ok().and_then(|u| u.host_str())` bytes.
/// Parse errors/no host succeed with empty output. No NUL terminator is written.
/// 0: success; -1: invalid ABI/UTF-8/bounds; -2: caught panic; -3: insufficient
/// output capacity (`written` receives the required byte count, no output writes).
///
/// # Safety
/// Input/output buffers must be valid for their lengths, `written` writable and
/// disjoint from those buffers. Null input is permitted only at length zero;
/// null output is permitted only at capacity zero (size query). No pointer is
/// retained after return. Library calls may run concurrently.
#[no_mangle]
pub unsafe extern "C" fn ziggy_url_host(
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    if written.is_null() {
        return -1;
    }
    *written = 0;
    if input_len > MAX_INPUT
        || capacity > MAX_OUTPUT
        || (input.is_null() && input_len != 0)
        || (output.is_null() && capacity != 0)
    {
        return -1;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let bytes = if input_len == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(input, input_len)
        };
        let text = match std::str::from_utf8(bytes) {
            Ok(text) => text,
            Err(_) => return -1,
        };
        let parsed = match url::Url::parse(text) {
            Ok(parsed) => parsed,
            Err(_) => return 0,
        };
        let host = parsed.host_str().unwrap_or("");
        if host.len() > MAX_OUTPUT {
            return -1;
        }
        *written = host.len();
        if host.len() > capacity {
            return -3;
        }
        if !host.is_empty() {
            std::ptr::copy_nonoverlapping(host.as_ptr(), output, host.len());
        }
        0
    }));
    match result {
        Ok(code) => code,
        Err(_) => {
            *written = 0;
            -2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host(raw: &str) -> String {
        let mut out = vec![0; 4096];
        let mut len = usize::MAX;
        assert_eq!(
            unsafe {
                ziggy_url_host(
                    raw.as_ptr(),
                    raw.len(),
                    out.as_mut_ptr(),
                    out.len(),
                    &mut len,
                )
            },
            0
        );
        String::from_utf8(out[..len].to_vec()).expect("URL host is UTF-8")
    }
    #[test]
    fn production_host_semantics_include_idna_legacy_ipv4_and_ipv6_brackets() {
        for (raw, expected) in [
            ("https://EXAMPLE.com:443/a?q=hidden", "example.com"),
            ("https://bücher.example/path", "xn--bcher-kva.example"),
            ("https://例え.テスト/", "xn--r8jz45g.xn--zckzah"),
            ("http://127.1/", "127.0.0.1"),
            ("http://0177.0.0.1/", "127.0.0.1"),
            ("http://0x7f000001/", "127.0.0.1"),
            ("http://2130706433/", "127.0.0.1"),
            ("http://[2001:0db8::1]:88/", "[2001:db8::1]"),
            ("https://user:fixture@exa%6dple.com/", "example.com"),
            ("not a URL", ""),
            ("https://", ""),
            ("mailto:fixture@example.com", ""),
        ] {
            assert_eq!(host(raw), expected, "{raw}");
        }
    }
    #[test]
    fn every_url_result_matches_direct_library_not_transport_endpoint_policy() {
        for raw in [
            "grpc://EXAMPLE.com:9090/",
            "grpc://bücher.example/",
            "file:///tmp/public",
            "foo://opaque_host/a",
            "http://example.com./",
            " \thttps://EXAMPLE.com/\n",
            "https://[::1]/",
            "http://1.2.3.256/",
            "//relative",
        ] {
            let expected = url::Url::parse(raw)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_default();
            assert_eq!(host(raw), expected);
        }
    }
    #[test]
    fn capacity_queries_never_write_partial_output_and_input_can_die_after_copy() {
        let raw = String::from("https://bücher.example/path");
        let mut len = 0;
        assert_eq!(
            unsafe { ziggy_url_host(raw.as_ptr(), raw.len(), std::ptr::null_mut(), 0, &mut len) },
            -3
        );
        let mut tiny = [0xA5; 2];
        assert_eq!(
            unsafe {
                ziggy_url_host(
                    raw.as_ptr(),
                    raw.len(),
                    tiny.as_mut_ptr(),
                    tiny.len(),
                    &mut len,
                )
            },
            -3
        );
        assert_eq!(tiny, [0xA5; 2]);
        let mut out = vec![0; len];
        assert_eq!(
            unsafe {
                ziggy_url_host(
                    raw.as_ptr(),
                    raw.len(),
                    out.as_mut_ptr(),
                    out.len(),
                    &mut len,
                )
            },
            0
        );
        drop(raw);
        assert_eq!(out, b"xn--bcher-kva.example");
    }
    #[test]
    fn ffi_invalid_utf8_bounds_and_nulls_fail_without_output() {
        let invalid = [0xFF];
        let mut out = [0xA5; 32];
        let mut len = 99;
        assert_eq!(
            unsafe { ziggy_url_host(invalid.as_ptr(), 1, out.as_mut_ptr(), out.len(), &mut len) },
            -1
        );
        assert_eq!(len, 0);
        assert_eq!(out, [0xA5; 32]);
        assert_eq!(
            unsafe { ziggy_url_host(std::ptr::null(), 1, out.as_mut_ptr(), out.len(), &mut len) },
            -1
        );
        assert_eq!(
            unsafe {
                ziggy_url_host(
                    invalid.as_ptr(),
                    MAX_INPUT + 1,
                    out.as_mut_ptr(),
                    out.len(),
                    &mut len,
                )
            },
            -1
        );
        assert_eq!(
            unsafe { ziggy_url_host(std::ptr::null(), 0, std::ptr::null_mut(), 1, &mut len) },
            -1
        );
        assert_eq!(
            unsafe {
                ziggy_url_host(
                    std::ptr::null(),
                    0,
                    out.as_mut_ptr(),
                    out.len(),
                    std::ptr::null_mut(),
                )
            },
            -1
        );
        assert_eq!(
            unsafe { ziggy_url_host(std::ptr::null(), 0, std::ptr::null_mut(), 0, &mut len) },
            0
        );
        assert_eq!(len, 0);
    }
    #[test]
    fn valid_query_larger_than_one_megabyte_keeps_source_host() {
        let mut raw = String::from("https://example.com/?fixture=");
        raw.extend(std::iter::repeat_n('x', 2 * 1024 * 1024));
        assert!(raw.len() < MAX_INPUT);
        assert_eq!(host(&raw), "example.com");
    }
    #[test]
    fn independent_calls_are_thread_safe_and_do_not_retain_buffers() {
        let threads: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| {
                    for _ in 0..100 {
                        assert_eq!(host("http://127.1"), "127.0.0.1");
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("worker");
        }
    }
}
