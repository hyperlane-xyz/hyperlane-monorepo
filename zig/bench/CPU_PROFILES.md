# Linux CPU profiles

New paired benchmarks use `locked-c520224-production-three-agent-linux-x86_64-v3-v2`.
Both implementations and rebuilt native dependencies target x86-64-v3:

- Rust: `-Ctarget-cpu=x86-64-v3`.
- Zig: Linux x86-64 with `x86_64_v3`.
- C and C++: `-march=x86-64-v3 -mtune=generic`.

`zig/tools/build_cpu.py` records the actual compiler command, selected compiler
environment, successful parent wait, source digest, and output digests. Consumers
check the required ISA against their actual host. Raw producer host flags remain
provenance; they are not the portable target requirements.

Historical v1 records retain their original full-host feature-subset check. Do
not relabel their artifacts or reuse their timings under the new profile. Rebuild
the complete producer cohort and measure both implementations again. The Rust
baseline remains `c5202242cc6569da4a858ed7ddbb34170ab696aa`.

The SVM receipt covers the rebuilt host client and SPL helper. Upstream Agave
binaries and SBF/Wasm programs retain their separate provenance and checks.
