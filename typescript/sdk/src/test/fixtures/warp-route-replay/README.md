# Warp route replay fixtures

Recorded JSON-RPC responses (`eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_estimateGas`) from
production routes whose reads broke the `EvmWarpRouteReader`. They are replayed
by `src/token/EvmWarpRouteReader.replay.test.ts` through an in-process JSON-RPC
server and the SDK's real `MultiProvider` provider stack, so the CALL_EXCEPTION
and nested error shapes are produced by ethers/SmartProvider, not hand-built.
Responses carrying a JSON-RPC `error` are replayed exactly as recorded. Bytecode
longer than 512 characters is stored as `resultGzBase64`.

Fixtures hold only addresses, bytecode, storage values and response bodies. No
RPC URL is stored.

All fixtures were captured on 2026-10-02 (block numbers are in each file).

| Fixture                        | Chain    | Router                                                        | Why it exists                                                                                                                                                                                                                                               |
| ------------------------------ | -------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bat-aleo-ethereum-collateral` | ethereum | `0x516e156e987175d74614cc2bC960f148A610f0b3` (BAT/aleo)       | Wrapped token `0x0D8775F648430679A709E98d2b0Cb6250d2887EF` is legacy bytecode (INVALID opcodes, no DELEGATECALL) that answers any unknown selector with `-32003 EVM error: InvalidFEOpcode`; the xERC20 probe must be skipped from bytecode.                |
| `magic-abstract-base-router`   | base     | `0xF1572d1Da5c3CcE14eE5a1c9327d17e9ff0E3f43` (MAGIC/abstract) | EIP-1967 proxy to an implementation with DELEGATECALL bytes and no `scale()`. The reader cannot rule the getter out, makes the call, and must tolerate the code 3 revert without data.                                                                      |
| `usdc-lukso-router`            | lukso    | `0xE0C2e4F894D4Cd33626e33b24582559F3156E1Ab` (USDC/lukso)     | EIP-1967 proxy to an implementation with DELEGATECALL bytes and no `feeHook()`. The reader makes the `feeHook()` call and must tolerate the LSP17 `NoExtensionFoundForFunctionSelector(bytes4)` revert; `scale()` answers 1.                                |
| `lyx-lukso-native-router`      | lukso    | `0xC210B2cB65ed3484892167F5e05F7ab496Ab0598` (LYX/lukso)      | Native router (8.1.2) whose implementation has neither `feeHook()` nor `feeRecipient()`; the lukso nodes revert both with code 3 and `data: "0x"`. The test replays the full `deriveWarpRouteConfig` read and asserts the reader makes no `feeHook()` call. |
| `blend-fluent-collateral`      | fluent   | `0x2bef59e84615371304bd731601f6344F5F304504` (BLEND/fluent)   | Collateral token `0x1385B8f55A84f2BdA13EeD4099d29Eae03d553b2` is an opaque delegation stub that answers unknown selectors with `Panic(uint256)`. The read must give collateral without throwing whether or not the xERC20 probe is made.                    |

Each scenario's test also checks that the fixture still has the property that
makes it a regression test (for example the MAGIC implementation contains a
DELEGATECALL outside PUSH data and lacks the `scale()` selector). If that check
fails, the recording was edited or re-recorded into something that no longer
covers the bug.

## Hex word encoding

The repo's pre-commit private-key heuristic (`.husky/pre-commit`) rejects any
added line containing a standalone 64-nibble hex word, which every EVM storage
slot and ABI word is. These fixtures hold only public data, so a hex word of
exactly 64 nibbles (with or without `0x`) is stored split in the middle by an
underscore, for example `0x00000000000000000000000000000000_00000000000000000000000000000001`.
`parseReplayFixture` (used by `loadReplayFixture`) joins the halves before
parsing, so replayed values are byte-identical to the recorded ones, and
`serializeReplayFixture` (used by `record.ts`) applies the split, so a
re-recorded fixture passes the hook too. Never bypass the hook with
`SKIP_KEY_CHECK`.

## Re-recording

Scenarios (router, chain, calls made) are defined in
`src/test/replayScenarios.ts`. With an RPC URL for the scenario's chain:

```sh
RPC_URL=<node url> pnpm exec tsx src/test/fixtures/warp-route-replay/record.ts <scenario>
```

The recorder runs the scenario's reader call and its raw probes against the node
through a recording proxy and rewrites `<scenario>.json`. Re-recording may change
the chain state a scenario relies on (for example after a router upgrade); check
the property assertions in the replay test afterwards. Nodes differ in how they
report reverts, so record from the same provider family the CLI hit when
reproducing a node-specific error shape.

## Derived variants

Some replay cases are synthetic variants of a recording, built in the test with
`withCallResult` / `withCodeSuffix` (`src/test/replayRpc.ts`). Everything except
the named change is recorded data. They are labelled `derived` in the test names.

| Variant                                                                          | Derived from                 | Change                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `magic-abstract-base-router (derived: scale() answers empty data)`               | `magic-abstract-base-router` | the recorded `scale()` revert is replaced by a successful empty `0x` result, which the provider stack surfaces as "All providers failed" caused by "Invalid response from provider"; the reader tolerates it because the bytecode does not prove `scale()` exists |
| `magic-abstract-base-router (derived: empty data from a proven scale())`         | `magic-abstract-base-router` | same empty result, and a PUSH4 of the `scale()` selector is appended to the implementation code; the reader must reject                                                                                                                                           |
| `magic-abstract-base-router (derived: unresolved beacon proxy, empty data)`      | `magic-abstract-base-router` | the router's implementation slot is cleared and its beacon slot set, so the implementation cannot be resolved, and `scale()` answers empty `0x`; the reader must reject                                                                                           |
| `magic-abstract-base-router (derived: unresolved beacon proxy, recorded revert)` | `magic-abstract-base-router` | same unresolved proxy with the recorded code 3 revert, which is tolerated                                                                                                                                                                                         |
| `usdc-lukso-router (derived: LSP17 revert for another selector)`                 | `usdc-lukso-router`          | `feeHook()` reverts with LSP17 `NoExtensionFoundForFunctionSelector` embedding a different selector; the reader must reject because the embedded selector is not the called one                                                                                   |
| `usdc-lukso-router (derived: forwarded feeHook() succeeds)`                      | `usdc-lukso-router`          | the recorded `feeHook()` revert is replaced by a successful address result, to prove the reader does not skip getters a forwarding implementation serves                                                                                                          |
| `usdc-lukso-router (derived: forwarded scale() succeeds)`                        | `usdc-lukso-router`          | the recorded `scale()` result 1 is replaced by 10^12                                                                                                                                                                                                              |
| `blend-fluent-collateral (derived: probe forced, recorded Panic)`                | `blend-fluent-collateral`    | a PUSH4 of the `mintingCurrentLimitOf(address)` selector is appended to the token code so the reader cannot rule the probe out; the recorded Panic answer is kept                                                                                                 |
| `blend-fluent-collateral (derived: probe forced, succeeds)`                      | `blend-fluent-collateral`    | same code change, and the probe answers 42, which makes the token an xERC20                                                                                                                                                                                       |

## Recorder guards

`record.ts` lets a failing reader call propagate and refuses to write when the
recording server hit a handler failure. `serializeReplayFixture` refuses to
serialize a fixture containing `http://`, `https://`, `key=` or `apikey`
(case-insensitive), since providers can echo URLs or keys in error bodies.

## Proving a scenario can fail

A scenario is only useful if a reader regression breaks it. Mutations used to
check this:

- tolerance removed (`throwIfNotMissingSelector` always throws and the legacy
  `scale()` catch removed): the MAGIC, USDC and LYX reads fail.
- guard made definitive for DELEGATECALL bytecode (`implementationHasSelector`
  returns `false` whenever the selector is absent): the forwarding variants and
  the MAGIC and USDC required-call tests fail.
- guard off (`implementationHasSelector` always `undefined`): the BAT and LYX
  forbidden-call tests fail.
