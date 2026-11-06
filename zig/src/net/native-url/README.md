# Rust URL host ABI

Validator metadata hashes `url::Url::parse(text).host_str()` exactly as the Rust agent does. This library uses url 2.5.4 and the exact idna/ICU dependency resolution selected by `rust/main/Cargo.lock`. It is a fifth native Rust library dependency, separate from the four protocol/regex SDK libraries; include its build, bytes and licenses in packaging and benchmarks.

Build only this crate:

```sh
python3 zig/src/net/native-url/locked.py --toolchain 1.98.0 --offline
```

Omit `--offline` only when explicitly provisioning uncached dependencies. `--target-dir PATH` selects a task-owned target. `--restore-only` restores the bounded packed lock without invoking Cargo; a conflicting existing raw lock is rejected. The helper generates `target/release/libziggy_url.{so,dylib}` and `target/release/ziggy-url-licenses`. The latter preserves exact available license texts and records all packages, sources, SPDX declarations, digests and missing texts. Existing differing output is rejected. The crate's LICENSE.md is the exact repository license.

ABI version 1 exports `ziggy_url_abi_version` and `ziggy_url_host`. The caller owns all input/output memory; no pointers survive a call. Output has no NUL terminator. Invalid URLs and hostless URLs produce empty host bytes. Return codes distinguish invalid ABI/UTF-8/bounds (-1), a caught panic (-2), insufficient capacity (-3 with required size), and success (0). Insufficient capacity writes no partial host. Calls may run concurrently; unload only after all callers join.

Input is bounded at 16 MiB, matching the existing settings-file byte limit; this is an operational configuration bound rather than an unrestricted parser claim. Output is bounded at three times that limit plus 256 bytes. The library performs no network, process or credential operations. Transport endpoint policy is independent of metadata host normalization.

`zig/src/net/url_host.zig` loads the ABI and returns allocator-owned UTF-8 host bytes. Service startup selects `HYPERLANE_URL_LIBRARY`, otherwise the packaged platform basename. Missing or incompatible libraries fail validator metadata startup before checkpoint/announcement publication.

Verification covers the direct Rust parser oracle, IDNA, legacy IPv4, IPv6, malformed/hostless URLs, ownership, buffer sizing, concurrency, allocation failures and a valid query larger than 1 MiB. Pure helper controls run with `python3 -B zig/src/net/native-url/locked_test.py`. Native Zig tests use `HYPERLANE_URL_LIBRARY=...` and `zig/src/url_host_tests.zig`; an absent environment path is an explicit native-test skip, not a successful parser proof.
