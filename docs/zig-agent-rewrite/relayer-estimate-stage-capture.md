# EVM estimate-stage capture

Two separate local diagnostics captured six `eth_estimateGas` responses and three broadcasts each, then deliberately stopped after the original early-inclusion guard. Both report **`DIAGNOSTIC_CAPTURE_COMPLETE_NOT_FUNCTIONAL_PASS`**. They did not complete the 600-second retirement proof and are not performance results. The original failed attempt did not retain its raw proxy trace; these later captures cannot recover its two response values or establish that they were the same.

[Archive manifest and all input hashes](../../zig/bench/results/relayer-estimate-stage-capture/manifest.json), [initial trace](../../zig/bench/results/relayer-estimate-stage-capture/initial/estimate-trace.json.gz), [full request/response trace](../../zig/bench/results/relayer-estimate-stage-capture/full/estimate-trace.json.gz), and [independent Source review](../../zig/bench/results/relayer-estimate-stage-capture/independent-review/ziggy-final-functional-estimate-review.md.gz).

The full capture preserves complete request params/results, RPC IDs, deterministic sequence, request Unix time and response Unix/monotonic times. Each preparation request has one object with exactly `{to, from, data}`. Its later Lander request has one object with `{to, from, data, gasPrice, value}`. The earlier reduced capture collapsed this distinction. For each matching call, the preparation response completed before the Lander request, which completed before the raw-transaction request. Neither request supplied an explicit block selector.

| Sequence (prepare / Lander / send) | Prepare RPC | Lander RPC | Send RPC | Preparation gas | Lander gas | Sealed weight matches preparation |
| ---------------------------------- | ----------: | ---------: | -------: | --------------: | ---------: | --------------------------------- |
| 0 / 1 / 2                          |          11 |         14 |       16 |         112,259 |    112,259 | Yes                               |
| 3 / 4 / 5                          |          52 |         57 |       59 |         155,879 |    155,879 | Yes                               |
| 6 / 7 / 8                          |          85 |         90 |       92 |         125,928 |    125,928 | Yes                               |

These equal preparation/Lander results are observations in this full diagnostic, not a guarantee that different source stages or node states always return equal estimates. The operation's original preparation result is the accounting weight; the later Lander estimate sizes submission. A source-correct matcher must preserve identity, stage and the pre-broadcast boundary, and keep ambiguous preparation candidates as an error. Selecting whichever result equals the expected sealed value would make the check circular.

The actual production Rust decoder's [stopped diagnostic DB readback](../../zig/bench/results/relayer-estimate-stage-capture/full/oracle-readback.json.gz), [command](../../zig/bench/results/relayer-estimate-stage-capture/full/oracle-command.json.gz) and [sealed matches](../../zig/bench/results/relayer-estimate-stage-capture/full/sealed-estimate-match.json.gz) bind the three durable preparation weights to RPC IDs 11/52/85. This diagnostic stopped before retirement: processed flags remain absent, expenditure values zero and payload stages `ready`. That differs from the separate prior failed-after-hold attempt's finalized DB readback. It does not establish delivery accounting or a passing 600-second proof here.

The diagnostic callbacks have a narrow recorded scope:

- Wrap `RpcProxy.__init__` to remember instances; the full variant adds in-memory estimate/broadcast lists.
- Wrap the response-capture callback to deep-copy the unchanged request and response plus timestamps, then call the original capture callback. It does not mutate RPC params/results or issue a new estimate.
- Wrap agent launch to supply the same matrix SDK/worker environment and record executable/environment identity; it calls the original launch.
- Call the original `early_included_guard` first. Only after it succeeds, save the trace and raise `DiagnosticCaptureComplete`, allowing normal fixture cleanup and aborting before the 600-second hold. A diagnostic script's successful capture exit is not functional acceptance.

Both traces record the same 29 input hashes and unchanged inputs at capture. The archive includes exact diagnostic scripts, commands, params/traces, config/partial/checkpoint JSON, agent logs, launcher/plan, Rust readback and review evidence. All source bytes from the captured pre-fix revision are already retained in the [four-source failed-attempt archive](../../zig/bench/results/final-relayer-estimate-identity-diagnostic/manifest.json). The current protocol-owned harness was being edited and was not treated as that historical snapshot.

At capture/archive time, the fixture-only correction was still in progress and had not completed independent review or a fresh full functional run. This archive makes no claim about later completion. Original files remain in both private diagnostic directories. The committed evidence consists of deterministic lossless gzip and chunked SHA descriptors; no DB files, WAL/SST data, executable or large parameter blob was copied, moved or deleted.
