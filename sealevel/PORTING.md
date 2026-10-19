# Porting a Sealevel program to Go

Rules for every port in `sealevel/programs`. The Rust program is the spec: same
instruction bytes, account order, account data, return data, error codes and
error precedence. `programs/ism/test-ism` is the reference port.

## Program shape

- `sealevel/programs/<rust path>/program.go`, its own package, with
  `func Process(c solana.Context) uint64`. The directory mirrors
  `rust/sealevel/programs/<rust path>`; `build-programs.sh` takes the ELF name
  from that Cargo.toml.
- Write the dispatcher by hand, in Rust's order. Example: test-ism tries
  `ism.Decode` first and falls back to its own Borsh enum on any error, so
  every malformed input ends up as `InvalidInstructionData`.
- Import only `sealevel/libraries/*`, `gosvm/solana` and `gosvm/sdk/*`. If
  two programs need the same helper, it goes in a library.
- Libraries: `borsh` (codec), `svm` (errors, account iteration, PDAs, System
  CPIs, rent), `account-utils`, `access-control`, `serializable-account-meta`,
  `interchain-security-module-interface` (`ism`), `message-recipient-interface`
  (`recipient`), `hyperlane-core` (H256/H160/U256, HyperlaneMessage,
  TokenMessage, ModuleType). Put message ID/merkle (keccak) code in
  `libraries/hyperlane-core`, not in a second copy.

## Codec

- Types implement `EncodeBorsh(w *borsh.Writer)` and
  `DecodeBorsh(r *borsh.Reader)` on the **pointer** receiver. Write fields in
  Rust declaration order. On value receivers goSVM copies the whole struct on
  every field read, which costs thousands of CU.
- Reader errors are sticky. Read every field, then check once:
  `r.Done()` matches `try_from_slice` (all bytes consumed), `r.Ok()` matches
  reader-based `deserialize(&mut &data[..])` (trailing bytes allowed). Pick the
  one the Rust call site uses.
- Strict like borsh 1.x: bool and Option tags must be 0 or 1, and String
  must be valid UTF-8. Enums: `r.EnumTag()`, then `r.Fail()` on an unknown
  variant.
- `Vec<T>`: `WriteVec`/`ReadVec` (capacity is bounded by the remaining input).
  `Vec<u8>`: `ByteVec` (copies) or `ByteVecView` (aliases the input; copy it
  before account data can change).
- `HashMap`/`BTreeMap`: a key-sorted `[]borsh.Pair[K, V]`, read with `ReadMap`
  (any input order, last duplicate wins) and written sorted (`SortPairs`).
  Sets: `ReadSet`/`SortUnique`. goSVM can't range over Go maps on chain.
- `U256` (`[4]uint64` LE limbs) is 32 LE bytes in Borsh. TokenMessage and
  other EVM-facing bytes are big-endian (`U256FromBigEndian`/`U256ToBigEndian`).
  `u128` is `borsh.U128{Lo, Hi}`.
- goSVM rejects recursion: walk recursive types (e.g. `MetadataSpec`) with
  an explicit stack.
- Interface instructions: use the `ism`/`recipient` packages. Their
  discriminators and PDA seed lists are already defined there.

## Errors

The u64 from `Process` reaches the runtime unchanged (`svm` constants):

| Rust                                           | Go                                                |
| ---------------------------------------------- | ------------------------------------------------- |
| `Ok(())`                                       | `svm.Success` (0)                                 |
| `ProgramError::X`                              | `svm.X` (`n << 32`, solana-program-error 3.0.0)   |
| `ProgramError::Custom(n)` / custom error enums | `svm.Custom(n)`, or the plain constant when n > 0 |
| `Custom(0)`                                    | `svm.CustomZero` (`1 << 32`)                      |
| borsh `io::Error` converted with `?`           | `svm.BorshIoError`                                |
| `AccountError::ExtraneousAccount`              | `accountutils.ErrExtraneousAccount`               |

- Copy custom enum values from the Rust source (they are often fnv1a hashes).
  The goldens list them under `errors`.
- goSVM's own codes (1001–1004, 2001–2018, 3001–3024) surface as `Custom(n)`
  and never match Rust. Check the condition yourself first, with Rust's code.
  `accountutils.Resize` and `svm.MinimumBalance` already map theirs.
- Traps (out-of-range index, nil dereference, out of memory, `panic`) fail
  as `ProgramFailedToComplete`, where Rust may return a code. Bounds-check
  everything decoded from input.
- When a CPI'd program fails, the transaction aborts with the callee's error,
  same as Rust.

## Accounts

- Take accounts with `it := svm.NewAccountIter(c); i, code := it.Next()`.
  It returns `NotEnoughAccountKeys` like `next_account_info`. Never index past
  `solana.Count(c)`: the SDK accessors trap.
- Interleave `Next()` and checks exactly as Rust does. The first failing check
  decides the error.
- Checks: `svm.KeyIs`, `svm.OwnerIs`, `solana.Signer`, `solana.Writable`,
  `solana.Executable`, `svm.DataIsEmpty`. Return Rust's error for each.
- Account data: `accountutils.FetchAccount[T]` (`{initialized: bool, T}`; empty
  or uninitialized gives the zero T, so apply Rust's `Default` yourself if it
  isn't all zeros), `accountutils.Store(c, i, &v, allowRealloc)`,
  `StoreWithRentExemptRealloc`, and `AccountDataSize(&v)` (= 1 + `Size()`) for
  space. Discriminated data: `WriteDiscriminator`/`ReadDiscriminator`,
  `DiscriminatorDecode`, `Read/WriteOptionalDiscriminated`.
- After a CPI, call `solana.Data(c, i)` again; older slices are stale.
- PDAs: seeds are separate segments (`[][]byte{"test_ism", "-", "storage"}`),
  never concatenated. `svm.FindProgramAddress` / `FindProgramAddressSeeds`
  search from bump 255 with one create_program_address syscall per try, so
  CU matches Rust. Pass the returned `svm.Seeds` to CPIs.
- PDA creation: `accountutils.CreatePDAAccount` has both of Rust's branches
  (create, or top up + allocate + assign). Don't use `system.CreateSigned`: it
  rejects pre-funded targets.
- Other CPIs: `svm.Metas` (at most 16) and `svm.Invoke(c, programIndex,
&metas, data, seeds)`. System helpers: `svm.SystemTransfer/Allocate/Assign/
CreateAccount`.
- SBF frames are capped at 4 KiB. Don't keep `pda.Seeds`/`cpi.Signers` or other
  big structs as locals; heap-allocate with `new` or `make`.

## goSVM integration-2 features

Available: `SetReturnData`, `GetReturnData` (check the setter key),
`Keccak256`, `Secp256k1Recover`, `MoveLamports`, `Log` (`msg!`; use
`svm.Msg` for Rust's value formats), `pda.Seeds.FindAddress`, `-max-accounts
64`, 64 CPI metas and 4 signer groups, Token-2022/ATA helpers. `copy`,
struct/array assignment and `for i := range s { s[i] = 0 }` lower to
`sol_memmove_`/`sol_memset_`; hand-written copy loops don't, so use `copy`.
APIs and error codes are documented in each upstream draft PR
([CrocSwap/goSVM#9 to #22](https://github.com/CrocSwap/goSVM/pulls?q=is%3Apr+author%3Apaulbalaji)).

## Tests

1. Native: `go test ./...` from `sealevel/`. Check encodings against
   `testdata/rust_vectors.json` (extend `tools/rust-vectors`) or the shared
   goldens (`internal/testvectors.LoadGolden`). Don't hand-write expected bytes
   when Rust can produce them.
2. Subset: add every new library to `internal/subsetcheck`. goSVM only checks
   packages that something compiled imports.
3. Conformance: run the Rust functional suite against the Go ELF.

```sh
GOSVM=gosvm-int2 sealevel/build-programs.sh
mkdir -p /tmp/elf && cp <Rust ELFs for the other programs the suite loads> /tmp/elf/
cp sealevel/target/fogo-v0/deploy/*.so /tmp/elf/   # includes spl_noop.so
cd rust/sealevel && SBF_OUT_DIR=/tmp/elf \
  RUST_LOG=solana_runtime::message_processor::stable_log=debug,solana_program_test=info \
  cargo test -p <suite crate> -- --nocapture --test-threads=1
```

- With `SBF_OUT_DIR` set, every `add_program` loads `<name>.so` and panics if
  it's missing, `spl_noop` included. Build the Rust ELFs with agave 3.0.14's
  `cargo build-sbf --tools-version v1.51` (the CI toolchain).
- Use **fogo-v0** ELFs. solana-program-test 3.0.7 loads them like the Rust
  v0 ELFs. It rejects solana-v3 ELFs (`UnsupportedProgramId`).
- Proof the ELF ran: `"<name>" SBF program from <path>` (info log) and
  `Program <id> consumed N of M compute units` (stable_log). Compare CU per
  test against the same suite on the Rust ELF.
- Known baseline failure: `mailbox-test::test_outbox_get_latest_checkpoint`
  runs out of CU on the Rust mailbox ELF too (200k), so it says nothing about
  a port.
- `rust/sealevel/programs/conformance.sh <elf-dir> [suite...]` automates this
  across suites and writes per-invocation CU JSON; `conformance/cu-diff.py`
  compares two runs.
