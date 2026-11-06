# Agent settings

`zig/src/settings/root.zig` owns layered config and typed role/chain values.
`Settings.load` takes explicit environment entries and argv; parsing never
constructs signers, connects RPCs or reads credential files. `loadProcess` is
an opt-in wrapper for a running agent. Tests do not call it.

Default JSON files are read in filesystem iteration order, then comma-separated
`CONFIG_FILES` in order, `HYP_` entries, and dotted CLI arguments. As in Rust,
CSV chain names and custom base RPC overrides are not trimmed. Numeric dotted
paths produce numeric-keyed tables; replacing an array discards its prior
entries. Typed array parsing requires contiguous numeric indices.

Production loader `environment.rs`, `arguments.rs` and `case_adapter.rs` are
compiled directly in the Rust `settings-merge` oracle. Fifteen differential
fixtures cover precedence, flatcase, indexed override replacement, sparse
indices, bare flags, quoting, negative values, explicit empties and malformed
argv. The current Zig suite also parses all 103 committed chains across the
seven protocols present in `rust/main/config` and all three agent roles.

Typed settings cover contract addresses, index/reorg options, signers, local/S3/
GCS checkpoint backends, Ethereum consensus/overrides/MEV, Cosmos gas and gRPC,
Sealevel priority fees/ALTs/submitters/reveal, Starknet denom, Radix gateway,
Aleo programs, Tron wallets, gas enforcement, matching filters, ISM cache,
relay API, and scraper CCR routers. Forty-seven additional fixtures compare actual production RelayerSettings,
ValidatorSettings and ScraperSettings acceptance and typed summaries. Configuration parsing is
not evidence that every configured service backend is operational.

Matching-list `body_regex` is preserved as a string. The relayer compiles it
through the pinned Rust `regex` 1.10.6 native adapter, selected with
`HYPERLANE_REGEX_LIBRARY`; configured regexes fail with `RegexEngineRequired`
when that adapter is absent. Matching uses lowercase message-body hex without
the `0x` prefix, matching Source. This adapter remains a Rust dependency.
Unknown duplicate canonical JSON keys are rejected,
where Rust's HashMap collection can choose either value. Inputs are bounded to
16MiB files, 32 nesting levels and 256-byte keys; these are explicit Zig limits.

Reproduce focused checks from repository root:

```sh
zig test zig/src/settings_tests.zig -O ReleaseSafe -lc --sysroot /path/to/MacOSX15.4.sdk -L/usr/lib
```

The committed-config tests resolve repository-root or `zig/` working directories.

Regenerate/check role fixtures with `python3 zig/reference/settings/generate.py
--check` after building the standalone oracle with the production lockfile seed.
The harness obtains the private relayer settings type through the production
`BaseAgent::Settings` associated type. Validator/scraper settings files are
included unchanged; a type-only two-variant checkpoint-consensus enum supplies
the included validator parser's crate-local type. No settings algorithms are
copied into the Rust harness. The generator clears the child environment and
uses a disposable config directory containing only committed/public fixtures.

The production role oracle now covers 62 fixtures, including 13 matching-list
edge cases. Scalar and array domain strings both use decimal u32 parsing
(`StrOrInt` arrays also reject hex/underscores); leading plus is accepted.
Explicit `bodyRegex: null` is absent, matching Rust Option deserialization.
Boundary/overflow and nullable-regex cases are regenerated through actual
production settings, with no environment/credential discovery.

`Chain.technical_stack` now retains the actual source enum (lowercase tags).
Known-domain values override configured `technicalStack`, matching Rust's Known
variant; unknown domains use the explicitly configured value or `other`. The
reference executable queries the production `KnownHyperlaneDomain` method for
all88 ID/alias entries. `python3 zig/reference/settings/generate_domains.py
--check` verifies the generated table; all62 independent role fixtures now also
compare each selected chain's technical stack. No runtime stack inference.
