# Optional Rust regex ABI

This is a third-party library boundary, analogous to the existing Starknet
native crypto adapter. It exists only to expose the exact Rust `regex`
implementation used by the canonical agents; no agent or regex semantics are
implemented here.

Build it explicitly (no Zig constructor loads it automatically):

```sh
python3 zig/src/ops/tools/locked.py --toolchain 1.98.0
```

`zig/src/ops/regex.zig` then loads the generated cdylib by explicit path. Keep
the exact lock in `tools/regex-lock.json`; the helper restores and verifies it
before `cargo --locked`. Do not commit native `target/` output.
`rust/main/Cargo.lock` pins `regex 1.10.6`, `regex-automata 0.4.7`, and
`regex-syntax 0.8.4`; those exact constraints are mirrored in `Cargo.toml`.
