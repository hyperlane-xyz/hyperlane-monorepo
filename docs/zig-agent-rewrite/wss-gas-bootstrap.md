# WSS gas bootstrap

Fresh gas v3 subscriptions omitted `afterStreamCursor` when no durable gas cursor existed. The real proxy interprets omission as tail. It sent a legitimate nonzero caught-up marker without historical rows, which the subscriber correctly rejected as skipped history. Rust explicitly requests cursor0; the corrected Zig subscriber does the same.

Actual stopped-copy evidence had messages/payments/payloads0–7 and nonce8 absent. The diagnostic captured logical session7 already closed: both gas cursors omitted, zero completed gas event frames, then markers A8/D0. Forbidden RPC counters were still empty. The fixture matched proxy semantics; changing it to replay omitted history would have hidden the production defect.

Commit `3c545589defcc4af3b2329013f43fa8bfeabd9ff` changes one runtime expression. Two new controller tests cover replay of nonzero history, canonical payment idempotency, authority handoff and durable restart; strict skipped-history/v2 behavior remains. Allocation tests now expect wire0; the existing nativeBridge test no longer seeds an artificial durable0.

The tests-first Safe run failed at expected0/foundnull (46 pass,1fail). Fixed Safe/Fast each passed47 discovered tests:2 new substantive and45 anonymous imports. Allocation/wire checks passed50 per mode; these counts overlap and are not unique totals. Owner34231 joined0; Root independently checked phase waits/logs/final source and22313 other protected hashes/inodes.

The nativeBridge Anvil path was not executed by these DB filters. No new role, broad-suite, nativeWSS/full600+30 or performance acceptance follows from this component. Old577 products/proofs stay historical; fresh runtime products and actual WSS proof remain required.

[Durable evidence](../../zig/bench/results/wss-gas-bootstrap-fix/README.md) retains exact before/proposed/final source, intended failure and pass logs, actual parent waits, resource/source/product checks, reviews and normal-hook commit provenance. No binaries, DBs, params or caches were archived.

Scope qualification (2026-11-07): the five filtered test commands launched real Node HTTP2/gRPC and RSA fixture children through `native_http_tests.py` under the bounded owner. No native-family chain node, Anvil, agent role, SDK build or prover ran. The archived preparation plan’s broad no-Node field is inaccurate; its raw bytes remain unchanged. See the [dated archive qualification](../../zig/bench/results/wss-gas-bootstrap-fix/scope-qualification-20261107.md).
