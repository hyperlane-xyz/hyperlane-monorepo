# Credential allocation test portability

The full Linux native suite exposed `NondeterministicMemoryUsage` in the credential
Manager allocation-failure test. Production credential handling was unchanged.

The test constructed settings, the Manager and both static AWS leases through one
fault-injection allocator. Linux could remap the settings arena in place: repeated
successful calls used 17 allocations/7,792 resizes, then 19 allocations/1 resize. An
injection index derived from one successful call could exceed the allocation count
of the next. Settings-only and isolated Manager sweeps both passed.

The test now refuses backing resize/remap operations, forcing growth through
allocation. The original complete settings→constructor→lease sweep remains; every
allocation failure and cleanup path is still checked. This does not claim coverage
of successful OS remapping. Independent review checked the standard allocator's
refusal/index semantics.

| System      | Mode        | Result |
| ----------- | ----------- | ------ |
| Linux arm64 | Debug       | 12/12  |
| Linux arm64 | ReleaseSafe | 12/12  |
| Linux arm64 | ReleaseFast | 12/12  |
| macOS arm64 | ReleaseSafe | 12/12  |
| macOS arm64 | ReleaseFast | 12/12  |

Each root contains nine substantive Manager tests and three import roots. These
overlapping runs are correctness evidence, not unique-case totals or benchmarks.
The four Safe/Fast runs retained one credential source hash. Reconstructing only
the replaced test lines exactly reproduces the earlier broad-run source hash,
confirming that the change was test-only.

The [manifest](../../zig/bench/results/credential-allocation-portability/manifest.json)
records 11 verified lossless payloads: the original failure, isolation and allocation
counts, final logs, commands, source identities and independent review. Broader
final native/container acceptance remains separate.
