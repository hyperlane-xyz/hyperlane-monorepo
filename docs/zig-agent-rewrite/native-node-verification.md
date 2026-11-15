# Native-node verification

The complete native-node acceptance matrix is still open: EVM, Tron,
CosmWasm, CosmosNative, Sealevel, Sealevel composite ISM, Starknet and Radix,
plus the separate Aleo daemon fixture. Pure codecs, dummy transports and
stopped database interoperability do not count as native-chain acceptance.
The execution registry remains empty until the complete family implementation,
source/build/tool closure and actual per-family capacity plan are reviewed.

The opt-in schema3 Rust coordinator retains the original Source workload and
all endpoint fallbacks. It explicitly selects the Zig roles, captures their
effective configuration, and owns actual parent stop/wait/restart receipts.
Default Rust test behavior remains unchanged. Every configured role must use
the same database and effective configuration after restart. Composite ISM has
its actual two-role category; ordinary scenarios retain scraper coverage.

Each accepted message needs an actual self-submission, canonical native
transaction/signature and result, exact membership and cost allocation,
checkpoint/signature publications, linked PostgreSQL rows and sequential
stopped RocksDB readback. The observer retains its first positive delivery
before returning the original response to the role. Each message must remain
active through its own600seconds, with an actual Confirm.SubmittedBySelf
witness, first retirement by630seconds and no reappearance or resubmission
after restart. Synthetic clock controls confer no elapsed-time credit.

## Isolated HTTP2 decoder setup

Cosmos can first observe delivery over gRPC. Its tap passively decodes the
original HTTP2 stream; it never rewrites frames or substitutes HTTP1. The
bounded decoder uses HPACK4.2.0 only in the correctness verifier. This is
separate from agent runtime and benchmark dependencies.

Create a new task-owned environment from the checksum-pinned wheel:

```sh
python3 zig/tools/h2_dependency.py \
  --destination /absolute/new/task-owned-hpack \
  --wheel /absolute/cache/hpack-4.2.0-py3-none-any.whl
```

Use `--download` instead of `--wheel` to fetch that exact release from official
PyPI. Offline setup records that it did not check the live package index.
Existing destinations are refused. The utility verifies the wheel checksum,
size and exact14-file closure before creating a copied, pip-free environment.
It installs no package hooks or additional dependencies. It requires6GiB free
and bounds the environment files at64MiB. Failure retains the owned directory
for diagnosis; it never removes unrelated caches.

The command prints `evidence/descriptor.json`. Bind its bytes/SHA in
`execution_approval.python_dependencies.hpack` and bind its copied interpreter
as `verifier.python`. Launch the coordinator/helper with
`PYTHONNOUSERSITE=1` and without `PYTHONPATH` or `PYTHONHOME`. Approval validates
the interpreter, venv configuration, wheel, package/license/metadata files and
source provenance before importing a verified source-only loader. Ambient
HPACK modules and bytecode cannot replace the pinned source.

Creating this environment grants no node execution or completed-case credit.
The independent family and shared-observer reviews, current runtime products,
complete tool/import closure and per-family disk/memory/image budgets remain
required before starting actual nodes.
