# Linux CPU profiles

New paired benchmarks use `locked-c520224-production-three-agent-linux-x86_64-v3-pclmul-native-abi-v4`.
Both implementations and rebuilt native dependencies target x86-64-v3 with PCLMUL:

- Rust: `-Ctarget-cpu=x86-64-v3 -Ctarget-feature=+pclmulqdq`.
- Zig: native GNU/Linux target ABI with `x86_64_v3+pclmul`.
- C and C++: `-march=x86-64-v3 -mtune=generic -mpclmul`.

`zig/tools/build_cpu.py` records the actual compiler command, selected compiler
environment, successful parent wait, source digest, and output digests. Consumers
check the required ISA against their actual host. Raw producer host flags remain
provenance; they are not the portable target requirements.

Zig uses `-Dtarget=native` or `-target native` to retain the publisher host's
GNU libc detection. The CPU remains explicit. The receipts normalize ISA
requirements; they do not promise compatibility with every glibc version.
Container linkage and actual consumer ELF/runtime checks remain required.

ARM64 Docker builds retain native compiler defaults and schema1 CPU records.
They are outside this x86-64 benchmark profile.

Historical v1 records retain their original full-host feature-subset check. Do
not relabel their artifacts or reuse their timings under the new profile. Rebuild
the complete producer cohort and measure both implementations again. The Rust
baseline remains `c5202242cc6569da4a858ed7ddbb34170ab696aa`.

The SVM receipt covers the rebuilt host client and SPL helper. Upstream Agave
binaries and SBF/Wasm programs retain their separate provenance and checks.
