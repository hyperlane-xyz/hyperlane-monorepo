# Validator signing conflicts

The validator now halts when checkpoint storage returns a valid signature from
its own key for a different value at the same domain, Merkle hook, and index.
The comparison includes both root and message ID. Identical checkpoints remain
idempotent; a foreign signer or misplaced object does not prove equivocation.
Local checkpoint reads now treat only `NotFound` as absence; other I/O failures
remain errors and cannot authorize fresh signing through a false missing result.

The halt is shared by live and historical workers. It blocks signing and
publication, marks readiness blocked, and persists the existing reorg guard
before exiting. A failed guard write leaves the process halted while retrying.
This reuses the guard as a publication stop; it does not establish a chain reorg.
The stored roots are the actual previous and proposed roots. They are equal for
a message-ID-only conflict; the error log records both complete checkpoint values.
As with root-mismatch detection, an already dispatched remote request may finish
after local cancellation.

## Why storage needs checking

RPC agreement authenticates the current history. It does not establish what this
validator signed before restarting. A restart with no usable Merkle snapshot can
reconstruct a new canonical history and encounter a checkpoint it signed on an
older fork. The GCS checkpoint syncer does not implement snapshot reads or
writes, so it uses the trait defaults and replays from an empty tree.

Before this change, `ValidatorSubmitter::sign_and_submit_checkpoint` warned and
overwrote any different value. The same path reaches local, AWS KMS, and GCP KMS
signers, then local, S3, or GCS checkpoint storage. All three storage writers use
unconditional writes. Ordinary StatefulSet updates provide one pod per validator
index, but there is no application-level fence against duplicated deployments.

This check only covers a conflicting signature returned by the storage read. It
does not cover missing/deleted objects, changing the storage location, or two
processes that both read an absent object before either publishes. Bucket
versioning retains evidence but permits a new current version.

## Follow-up: durable signing intent

The larger project should reserve the signing hash **before** invoking any
signer. Use `(signer, domain, Merkle hook, index)` as the key and the complete
checkpoint signing hash as its immutable value. A matching reservation permits
an idempotent retry; a different hash must trigger the shared halt.

- S3: conditional create with `If-None-Match: *`.
- GCS: conditional create with `ifGenerationMatch=0`; the current `ya-gcp`
  wrapper does not expose this precondition.
- Local storage: exclusive creation and durable synchronization; readers must
  distinguish an incomplete reservation from absence after a crash.

Publish checkpoints with a conditional create too, and compare an existing
signed value on a collision. Keep latest-index publication monotonic under
multiple writers. A write collision after signing alone is too late: two
different signatures already exist.

Migration must stop old writers, import existing signed checkpoints into the
reservation store, verify the complete import, and then enable guarded signing.
All deployments using the same key need the same reservation authority. Removing
or changing that authority requires an explicit operator recovery procedure;
silently creating a new store would defeat the guard. Limit deletion and
unconditional replacement of reservations through storage permissions.

Test two writers with different hashes, matching retries, crashes before and
after reservation/signing/upload, lost responses, unreadable reservations,
partially imported history, and an attempted old-writer restart. Roll out on a
testnet validator first and verify duplicate reservations remain idempotent and
conflicts block every publication path.

Storage primitives: [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html),
[GCS request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions).
