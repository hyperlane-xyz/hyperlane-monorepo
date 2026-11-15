# Relayer estimate proof correction

Commit `853c150592` corrected the acceptance fixture's gas-estimate identity
check. It changed three Python integration fixtures and added one pure test.
Normal commit hooks passed. Production Zig/Rust inputs and all 22 checked build
products stayed unchanged from build commit `516bdf4290`.

The earlier v2 run reached retirement and stopped Rust database readback, then
failed receipt verification because two pre-broadcast estimates matched the same
sender, Mailbox and calldata. The proxy had discarded the fields distinguishing
operation preparation from Lander transaction sizing. Requiring one match was
therefore invalid.

The separate [stage capture](../../zig/bench/results/relayer-estimate-stage-capture/manifest.json)
recorded both requests for each of three messages. Preparation sent exactly
`{to,from,data}`. Lander added `value` and `gasPrice`. The results happened to
match in that diagnostic; production does not require equality. Both requests
omitted a block selector, so neither estimate is evidence of execution at a
specified historical block.

The original preparation result is the value copied into
`payload_links.Record.estimated_gas` before enqueue. Native receipt accounting
uses that sealed weight and the sum of sealed member weights. Later singleton,
batch-member and aggregate estimates size the signed transaction; they do not
replace those weights.

The corrected proof retains full request/response envelopes, IDs, request-start
and completion clocks, including failed estimate attempts. Both HTTP handlers
capture actual monotonic request-start time before upstream work. Selection
requires exactly one successful request with one parameter containing exactly
`to/from/data`, matching the operation identity and completing strictly before
the first matching broadcast request starts. The result is then independently
compared with the stopped-database sealed weight. Duplicate successful
preparation candidates remain errors; selection never uses the expected weight
or first/last array position.

Raw traces cover gas estimation and broadcast responses, including RPC errors.
Retirement, stopped Rust readback and a hashed trace checkpoint are saved before
receipt assertions. Nested failure handlers retain completed stages and the
actual assertion error. Existing canonical-receipt, ProcessId membership,
four-member batch allocation, rounding and 600-second retirement checks remain.

| Verification                              | Result                                      |
| ----------------------------------------- | ------------------------------------------- |
| Estimate capture, selection and progress  | 10/10, owner and independent                |
| Earlier initial-metric guard              | 10/10, owner and independent                |
| Existing retirement/helper controls       | 28/28, owner and independent                |
| Existing static contract controls         | 21/21, owner and independent                |
| Additional independent pure probes        | 3/3: clocks, ordering, nested error merge   |
| Frozen harness/test and production hashes | 14 matched before, after and final readback |
| Post-hook compiled-product readback       | 22 unchanged                                |

The [correction packet](../../zig/bench/results/relayer-estimate-proof-correction/manifest.json)
contains exact commands, owner and independent logs/reviews, four committed
source blobs and diff, the unchanged earlier guard hash, normal commit output
and post-hook preservation proof. Its deterministic gzip payloads have raw and
compressed SHA256 chunk pairs; the [archive verification](../../zig/bench/results/relayer-estimate-proof-correction/verification.json)
records the decoded readback.

Relative to harness commit `baf14145ae`, four files changed. Relative to runtime
build commit `516bdf4290`, three existing fixtures changed and two pure test
files were added across the two corrections. The original source map is not
wholly unchanged; the compiled runtime bytes are. Existing diagnostic traces
and stopped-fixture evidence remain in their separate archive.

This packet seals the fixture correction and pure checks. It contains no new
completed 600-second functional acceptance or performance result. The original
failed run did not persist its full estimate requests; the separate early
diagnostic does not reconstruct that lost trace.
