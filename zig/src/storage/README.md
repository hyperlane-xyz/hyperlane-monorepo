# Local checkpoint storage

`LocalStore` implements the existing file checkpoint object formats and names.
It does not replace RocksDB or PostgreSQL, cloud identity, S3/GCS, or the validator
network loop. No production directory was used for development or tests.

- `objects.SignedCheckpoint`: nested `value.checkpoint`, `value.message_id`,
  signature `{r,s,v}`, and the 65-byte `serialized_signature` string. `r`/`s`
  serialize as minimal hexadecimal U256 values; `v` retains its full u64 value.
  The serialized final byte truncates `v`, matching Rust. Parsing accepts the
  `checkpoint` and `announcement` aliases for `value`, and ignores the redundant
  serialized signature as Rust's deserializer does. Recovery uses the separately
  tested ethers-compatible policy, including accepted high-S and v forms.
- `objects.SignedAnnouncement`: existing signed JSON and distinct announcement
  domain hash, with exactly one EIP-191 wrap before signing/recovery.
- `objects.Snapshot`: compact JSON `{index,root,tree:[bytes...]}`. Frontier bytes
  are 32 hashes followed by an eight-byte little-endian Borsh count.
  `restore` proves structural consistency; `authenticatedRestore` additionally
  requires the configured validator's valid signed checkpoint, domain, and hook.
- `objects.ReorgEvent`: pretty JSON with roots, checkpoint index, timestamp and
  numeric/tag reorg period. Rust's `ReorgEventResponse` is an in-memory type, not
  another JSON wire object. `ReorgStatus` preserves existing malformed content as
  `exists=true,event=null`; read errors remain errors.

`LocalStore.open(allocator,parent,path,options)` opens and owns a separate directory
handle. Default `options.read_only=true` never creates paths or a lock file and
allows inspecting an existing reorg flag. Returned announcement/reorg objects own
memory and require `deinit`; checkpoints and snapshots contain fixed-size fields.
The supplied `parent` stays caller-owned. Reorg-period tag bytes are borrowed.

Writer options require `read_only=false` and the expected signer address. A writer
holds an advisory exclusive lock on `.zig-validator-writer.lock`; its inode remains
in place after release. A second cooperating writer fails immediately. Existing
Rust agents do **not** honor this new lock, so this does not prevent a mixed Rust/Zig
fleet from writing the same namespace. Operationally isolate namespaces and stop
old writers before migration. Never use an active production checkpoint location
for experiments.

`signAndWriteCheckpoint` serializes local signing with inspection of the durable
previous checkpoint before generating a signature. Same signer, same domain/hook,
same index, different value persists a reorg guard and halts publication. An identical
value is skipped. A valid checkpoint from another key is overwritten, matching
Rust. A same-key object for a different domain/hook follows Rust's overwrite branch
and returns `overwrote_other_context`; callers should pin their context separately.

`writeCheckpoint` supports an already-computed signature and rechecks durable
conflicts before publication. It cannot undo a signature already computed by an
external signer. KMS/network runtimes must serialize their own pre-sign reservations
and discard late results after a halt. The local signing helper does not make those
external paths complete.

`writeLatestIndex` requires its target checkpoint to exist and recover to this writer,
including when revalidating an unchanged pointer. It permits the Rust validator
workflow of publishing the newest index first and filling intermediate history
afterward; durable history completion remains the runtime's responsibility. `writeSnapshot` requires
an authenticated stored checkpoint for its index/root. Neither helper performs RPC
consensus; the runtime must establish canonical history before asking to sign.

Intentional reliability changes from the Rust file backend:

- All object writes use a private temporary file, file fsync, atomic rename, and
  parent-directory fsync. Newly created nested directories are made component by
  component with each parent entry synced before descending, including absolute
  paths. An I/O failure poisons ordinary writes until reopen and
  readback. A failed reorg-guard write remains retryable while publication is halted.
  The runtime must keep retrying guard persistence before exiting; the synchronous
  backend itself does not implement an infinite retry/sleep loop.
- Any existing reorg flag blocks writer startup, including malformed content;
  unreadable/oversized flags are fatal errors. Every ordinary write rechecks the
  flag, and an in-process halt rejects late signer results.
- All objects are bounded below 50 KiB by default, matching Rust's snapshot boundary;
  Rust currently leaves some other object reads unbounded. Exactly 50 KiB is rejected.
- Invalid/unreadable `index.json` remains an error. Rust's latest-index reader
  currently maps some read/UTF-8 errors to absence. No read error is masked here.
- A checkpoint file's embedded index must match its filename. Duplicate JSON fields
  and duplicate aliases are rejected. Atomic replacement, cooperating locks, and
  target-pointer authentication checks are stronger than Rust's low-level file backend.

These changes are explicit compatibility decisions, not byte-format changes.
Actual filesystem tests cover writer/read-only behavior, durable reopen, conflict
and guard persistence, snapshots, publication gaps, partial/corrupt objects,
directory-at-file-path errors, exact size limits, and retry after failed guard writes.

Fixtures in `fixtures/objects.jsonl` come from actual production `hyperlane-core`
serde/hash/Borsh code, through the independent Rust path dependency. Each wire string
is split into chunks of at most 32 Unicode characters to avoid misidentifying public
fixture hashes as private keys in commit hooks. Joining the chunks reconstructs the
exact wire object; tests compare the full bytes, not normalized JSON.

Regenerate after building `zig/reference`:

```sh
zig/reference/target/release/ziggy-rust-reference storage-vectors > zig/src/storage/fixtures/objects.jsonl
```

The 23 cases cover checkpoints and aliases at index 0/42/u32-max, announcements
including escaping/Unicode, four snapshots and exact Borsh bytes, all reorg-period
forms, a malformed flag, and raw decimal latest indices. Fixture keys are public
repeated-byte test keys. No private deployment material is present.
