# Independent native-operation row reader

New standalone Rust/RocksDB reader. It does not modify or replace the original
canonical-message/gas/payload oracle. The old source and binary remain untouched.

V1 component checks and actual storage interoperability passed. Offline metadata
normalized the lock to64 registry packages, all exact baseline versions/checksums.
Rust discovered9 tests (8 substantive plus a child helper); release build and
package Clippy with warnings denied passed. Actual production Zig Store/Operation
writers passed in both Safe/Fast modes, including full32/64-byte identities,
private-field exclusion, large u256 costs, live-writer refusal and unchanged DB
bytes during read-only reopening. The compiled reader is6,804,512 bytes; exact
product/source pins and logs are in the native-row-reader evidence packet.

This approval is structural reader/codec evidence only. No actual chain, SDK
signature, finality, delivery or elapsed600s hold is established. Family adapters
still need independently bound authority/signer/wire and actual chain acceptance.
The prior source-phase README remains preserved with its compiled snapshot;
that V1 update changed documentation only.

The public Starknet quote extension and Aleo resolved-target storage shape now
pass13 Rust tests (12 substantive plus a child helper), offline release build,
package Clippy and12 pure helper/structural controls. Actual five-row production-API
storage interoperability passes Safe/Fast, including atomic group storage and
read-only reopening. Independent review is pending. V1 products and accepted
two-row fixtures remain preserved separately; no family/chain/SDK/600s acceptance
is granted. The exact README used for these builds is preserved separately; this
status update changes documentation only, without recompilation or executable
changes.
Run the reader with one request file:

```json
{
  "marker": "ziggy-native-rows-readonly-v1",
  "db_path": "/absolute/task-fixture/stopped-db",
  "origin_namespace": "test1",
  "origin": 1000,
  "destination": 2000,
  "operations": [
    {
      "id": "0x<32 bytes>",
      "nonce": 7,
      "kind": "process",
      "target": null,
      "context": null
    }
  ]
}
```

The request permits at most256 unique operations. Context must be explicitly null
or32 bytes. Null yields `expected_context_checked:false`: an observed context,
not independent verification of Factory configuration authority. Replay/restart
callers must pin the first context, generation, identity and intent/signed hashes.
Auxiliary kinds require an explicit target.

The key is exactly namespace + `_zig_native_destination_operation_v1/` + raw32-byte
ID. Rows, intent and signed bytes are bounded at64/2/16MiB, total rows at256MiB.
Duplicate JSON fields (including payload fields), unknown typed fields, missing
nullable fields, inconsistent stage/signed tuples and key/request/prepared
cross-bindings fail closed. Missing rows return `present:false`, `complete:false`;
that is not a passing proof.

Output contains public lifecycle/authority fields and full32-byte hash or64-byte
signature identity. Row, stored canonical-intent field and signed wire are
reported only by SHA256 and byte length. The reader does not independently
canonicalize a native payload or validate its SDK signatures. It never outputs
raw authorization, transition view keys, private witness, intent payload or signed
wire. Errors are fixed codes, not untrusted JSON error text.

For a current signed identity it also checks the separate expenditure marker,
including identity/tag and exact little-endian u256 gas/token fields. Absent cost
is absent, not invented zero; a present zero marker remains distinguishable.
The original canonical oracle must independently establish aggregate accounting.

Before opening RocksDB read-only, an existing nonsymlink LOCK is held under
POSIX `fcntl(F_SETLK)` shared locking, conflicting with RocksDB writer locks. No DB
or lock is created. A separate family-verifier receipt must still prove every
role/writer process was stopped and reaped; lock availability alone is not that
receipt. Tests include a separate actual Rust/RocksDB writer process to avoid
POSIX same-process lock semantics. The intended read-only test hashes all DB
files before/after the read.

Family acceptance must use this reader **and** the unchanged canonical oracle,
actual chain receipts/blocks and SDK verification. Run the two readers sequentially
on a stopped DB: the original canonical oracle opens a writer and cannot run
concurrently with this shared-lock reader. Bind protocol, mailbox,
chain ID, hook, signer authority and native transaction fields to the actual case.
A reader result alone proves neither delivery, on-chain identity nor policy parity.

`locked.py` defaults to a plan. It cannot start Cargo without `--execute` and keeps
a6GiB floor. Before execution Root must approve the exact target/graph and native
archive pins. The accepted macOS build reused the pinned RocksDB/Snappy
archives and matching headers, rebuilt matching codec crates, and linked system
libc++; it did not force all six archive paths manually. No compilation or node execution is authorized by this README.

## Public Starknet quote extension (Source phase)

Only Starknet Prepared payloads expose `operation.starknet`:

```json
{
  "gas_limit": 1,
  "estimated_cost": "1766847064778384329583297500742918515827483896875618958121606201292619793",
  "batch": {
    "version": 1,
    "members": [
      {
        "operation_id": "0x<32 bytes>",
        "origin": 1000,
        "origin_hook": "0x<32 bytes>",
        "generation": 1,
        "source_intent_digest": "0x<32 bytes>",
        "gas_limit": 1,
        "estimated_cost": "1766847064778384329583297500742918515827483896875618958121606201292619793"
      }
    ]
  }
}
```

The illustrative member shape is abbreviated; actual batches require2–256 ordered
unique members and positive total original gas weight. Scalars have `batch:null`.
Every own member must match the row authority, generation, origin hook and scalar
quote. The Source producer's raw hex64 fields are normalized to full0x32-byte
public hashes. Costs are canonical decimal strings after exact bounded RawValue
validation; no float conversion is used. The new serde_json `raw_value` feature
uses the same pinned dependency graph. Transaction/private payload/auth/signed
bytes remain omitted.

This exposes **stored frozen allocation weights**. It does not prove original
scalar RPC estimate provenance. A family must independently validate the actual
signed Invoke/account/call membership, canonical fee, all sibling rows, allocation
and rounding dust; the original quote-to-manifest construction is separately
covered by production unit controls.

Aleo process rows intentionally retain `operation.target:null` while preparation
pins a resolved nonnull32-byte program hash in `authority.target`. Only that exact
protocol/kind/row-null shape permits this difference. Other protocols and auxiliary
kinds retain exact target equality. This public prepared target is observed data,
not configuration verification: family evidence must independently bind the
program to recipient, signed call, native SDK and actual receipt.

The extended actual production-API writer has5 canonical messages:
Starknet scalar, Sealevel full512-bit identity, two unequal-weight Starknet members
using real atomic group journal/sign/confirmation storage transitions, and Aleo's
resolved-target process. Group original estimated costs exceed2^240+17. Synthetic clocks
and signed bytes still provide zero SDK/chain/finality/elapsed600s credit. The
Python validator additionally refuses a mismatched resolved target even if writer
and reader agree on it, and independently checks typed marker byte hashes.
