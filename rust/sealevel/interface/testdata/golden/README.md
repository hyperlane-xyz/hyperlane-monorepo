# Sealevel interface golden vectors

Byte-compat oracle for the Sealevel program interfaces (instruction data, account data,
PDAs, error codes, constants). Generated from the on-chain Rust program crates; checked
against `hyperlane-sealevel-interface` and intended for non-Rust ports (goSVM) too.

Regenerate (from `rust/sealevel`; only the program-side oracle writes files):

```sh
GOLDEN_UPDATE=1 cargo test -p hyperlane-sealevel-interface-goldens --test programs
```

Check without writing: `cargo test -p hyperlane-sealevel-interface-goldens -p hyperlane-sealevel-interface`.

Cases live in `../../goldens/cases/*.rs` and are compiled against both the program crates
and the interface crate, so both sides encode the same values.

## Format

One file per program/library. Top level:

| key            | contents                                                         |
| -------------- | ---------------------------------------------------------------- |
| `program`      | file name stem                                                   |
| `values`       | encoded values (below)                                           |
| `instructions` | outputs of Rust instruction-builder helpers: `name`, `program_id`, `accounts` (`pubkey`, `is_signer`, `is_writable`), `hex` data |
| `pdas`         | `name`, `program_id`, `seeds` (hex each), `address`, `bump` from `find_program_address` |
| `errors`       | `name` (`Enum.Variant`), `code` (the `ProgramError::Custom` value) |
| `constants`    | `name`, `value`                                                  |

Each `values` entry: `type` (`<program>.<RustType>`), `variant` (top-level enum variant or
`null`), optional `name` (distinguishes cases), `encoding`, optional `discriminator` (hex),
`fields`, `hex` (the bytes, no `0x`).

`encoding`:

- `borsh`: `borsh(value)`.
- `discriminator+borsh`: `discriminator || borsh(value)` (8-byte type discriminator, e.g.
  `PROGRAM_INSTRUCTION_DISCRIMINATOR = 0x0101010101010101`).
- `variant_discriminator+payload`: per-variant 8-byte discriminator, then the variant
  payload (ISM / message-recipient / multisig-ISM interface instructions).
- `account`: on-chain account data, `0x01 (initialized) || borsh(value)`.
- `account+discriminator`: `0x01 || discriminator || borsh(value)`.
- `custom:<fn>`: fixed-layout bytes parsed by `<fn>`; `hex` is the input, `fields` the result.

`fields` JSON conventions: integers up to 32 bits are numbers; `u64`/`i64`/`u128`/`usize`
and `U256` are decimal strings; `Pubkey` is base58; `H256`/`H160`/byte strings/byte arrays
are `0x` hex; `Option::None` is `null`; tuples are arrays; maps are arrays of `[key, value]`
and sets are arrays, both in ascending key order (borsh sorts them). Enums are externally
tagged: unit `"Name"`, newtype `{"Name": value}`, struct `{"Name": {...}}`. A trailing
`OptionalDiscriminatedData` field is its inner value or `null`; when present its bytes are
`discriminator || borsh(inner)` (discriminators are listed under `constants`), when absent
it encodes to nothing.

`fee.json` and `token_cross_collateral.json` are oracle-only: no off-chain Rust consumer
uses those programs, so the interface crate doesn't mirror them.
