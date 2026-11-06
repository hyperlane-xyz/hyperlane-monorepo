# Remote checkpoint engine

`remote_checkpoints.Engine` owns one I/O thread and native `curl_multi.Multi`.
Metadata workers wait for complete quorum operations; remote validators consume
native sockets rather than a blocking worker each. A separate four-worker pool
handles local filesystem readers. Both backends feed one arrival-ordered quorum
collector, including mixed local/remote thresholds.

## API

- `Engine.start(thread_safe_allocator, Config) !*Engine`
- `register(RemoteReader{origin, validator, location_id, backend, ignore_reorg_reports}) !void`
- `registerLocal(checkpoint_pool.Reader) !void`
- `registerLocations(origin,validator,[]const Candidate) !void`, with `Candidate` a union of `.remote:RemoteReader` and `.disk:checkpoint_pool.Reader`
- `unregister(origin,validator)`; empty `registerLocations` also removes the cached entry
- `hasReader(origin,validator)` / `hasLocation(origin,validator,location_id)`
- `fetchQuorum(origin,allocator,validators,threshold,index,*storage_errors,cancel) !?quorum.Quorum`
- `latestIndices(origin,validators,output,*storage_errors,cancel) !void`
- `deinit()` after all metadata callers have returned.

`Config.multi` is `net/curl_multi.Config`; load an explicitly configured vetted
libcurl with asynchronous DNS. Defaults: 256 concurrent native HTTP requests,
512 pending requests, 64 MiB of application payload reservations; 32 sessions,
4,096 registered locations, 30-second session deadline. Descriptor size is
bounded to 64 KiB. Session admission and HTTP capacity exhaustion are explicit.
Queued HTTP time counts against the session deadline. Idle engines sleep on a
condition; active owners pump native I/O every millisecond.

The owner admits at most 16 new requests from a session per pass, then services
other sessions. Increase the global native concurrency only using measured host
and endpoint capacity. All peers of one maximum-size validator set can start at
the default 256 limit; no eight-worker configured-order head-of-line gate exists.

## Ownership and safety

Registration copies remote URLs, bucket/folder/region, credentials and bearer
bytes. No URL, header or credential is logged. Local registration requires a
reorg validation callback and paired retain/release callbacks when provided.
Readers without retain/release must remain alive until engine destruction.

A request retains its exact latest-first ordered locations once. Registrations
allow at most 256 candidates and 64 KiB of aggregate remote descriptor bytes.
Invalid candidate configurations are skipped; an entirely unusable list removes
the cached entry and returns `NoUsableCheckpointLocations`. `hasLocation` compares
the first candidate ID, which may encode the whole registration version.

A request retains its exact registrations once. The entire selected set passes
the reorg-guard phase before any checkpoint/latest request begins. Registry
rotation/eviction drops only the registry reference; it cannot substitute a new
location between guard and data reads. GCS checks the legacy root flag first
when a folder exists, then the scoped flag. A present object is a flag even if
its JSON is malformed or empty. Default behavior aborts the whole operation;
`ignore_reorg_reports` skips that location and tries the next older candidate.
An unreadable candidate also advances to the next location. Local/cloud fallback
works in either order. No data is fetched until every validator has selected a
successfully guarded location or exhausted its candidates.

An unreadable guard increments storage diagnostics; a peer becomes unusable only
after every candidate has failed.
This is deliberately stricter than Rust's cached-backend recheck fallback, which
may assume no reorg after a read error. It does not abort healthy peers' quorum.
The ordinary storage object rules remain exact: anonymous S3 GET, GCS optional
bearer, source key names/path escaping, exclusive 50-KiB bounds, and S3 404 only
means missing when the body contains `NoSuchKey`.

Callers may register and read concurrently. Cancellation returns promptly while
the owner drains HTTP completions; session refs and cancellation tokens remain
alive until native handles are removed and local worker cleanup finishes. Late
responses are discarded. Local callbacks must honor their cancellation token;
filesystem cleanup is joined at shutdown. A canceled session cannot mutate a
later session or registration.

Production endpoints require HTTPS. `allow_insecure_loopback` permits only
literal loopback test endpoints. Trusted cloud and public-only CCIP HTTP use
separate native connection caches, preserving socket-level egress validation.

## Tests

`remote_checkpoints_testing.zig` uses disposable loopback HTTP and fake local
readers: sixteen-peer fanout with the first eight stalled; all-guard ordering;
a delayed malformed flag behind two healthy peers; ignore/skip behavior;
concurrent origins; caller cancellation and later reuse; mixed local/remote
quorum; retained registry rotation; exact GCS legacy/scoped objects and owned
bearer/folder bytes; unreadable guards; deadline cleanup and reference balance.
Native cases require `HYPERLANE_CURL_LIBRARY`; default tests load no native library.

### Cooperative metadata reads

`Engine.submitQuorum(origin,resultAllocator,validators,threshold,index)` and
`submitLatest(origin,validators)` return an owned `*ReadRequest`. They enqueue
work without waiting for HTTP. `request.poll(cancel)` returns `pending`,
`quorum:?Quorum`, or `latest:[]const?u32`; terminal values/errors consume the
lookup and another poll returns `RemoteReadAlreadyConsumed`. Quorum retains its
usual caller-owned signature allocation; latest borrows the request until
`deinit`. Copy it before destroying the request. All validator IDs and registered
locations are retained copies, and cancellation is sampled only during poll.
`deinit` closes the session and releases its caller reference; native/disk owner
references survive until their real work drains. Destroy requests before Engine.

`request.storage_errors` accumulates diagnostics exactly once internally. Add it
to caller metrics once at terminal completion, not on every PendingReadIo replay.
A metadata Source journal must cache/clone terminal values itself. The global
all-location guard phase, ignore/fallback policy, mixed disk/cloud collection,
arrival order and deadline semantics are shared with blocking reads.
