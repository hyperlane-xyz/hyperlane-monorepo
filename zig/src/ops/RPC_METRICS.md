# Physical RPC metrics

`rpc_metrics.Recorder` updates the source-schema counters
`hyperlane_request_count` and `hyperlane_request_duration_seconds` (summed elapsed
seconds, not a histogram). Label order follows Rust:
`provider_node,connection,chain,method,status,rpc_role,operation`.
Registry appends agent/version labels. Nodes are configured public host:port,
without URL userinfo, path, query or headers. Methods are bounded to128 ASCII
letters/digits/underscore/dot; unexpected values become `unknown`.

`chain_source.Options` accepts `metrics`, `rpc_role` and `operation`; Resources
owns the recorder through native client/Pool teardown. Recorder configuration is
immutable while callbacks run. Pool emits physical upstream completion events,
including fallback probes; logical completion/retry events do not increment RPC
counters. Curl observes only actual synchronous native sends. Its read-only
`send_override` bypasses observation so cache hits and PendingReadIo unwinds are
not phantom requests. Cancelled/dropped hedge futures are omitted like Rust.

Async replay consumers use `describe(request,*[128]u8)?Description`, retaining only
an immutable public host and caller-owned method bytes, then
`responseSuccess(description,*Response)` and `record(...)` on real completion.
Alternatively `recordNative(Observation)` handles an immediate borrowed request.
Never retain a Description.method slice across movement of its backing object
without rebinding the slice. Destroy writers before Recorder and Registry.

Callback registry failures increment Recorder.failures atomically and warn once
with the error name only. They do not turn successful RPCs into failures. Native
HTTP observations classify HTTP status, JSON-RPC envelopes and gRPC status;
provider-specific typed payload decoding occurs afterward. Thus malformed
chain-specific REST result schemas may still need a provider-level observation
hook for exact Rust typed-result status parity. This limitation must remain
visible in metric parity claims.

Focused native fixtures verify success/failure count1/2, physical fallback+probe
methods, gRPC status classification, original request destruction, cancellation
omission and absence of credentials/paths in rendered metrics. The full existing
RPC strategy regression suite passes after observer/handle changes.

For shared endpoint pools, `Recorder.poolObserverFor(operation)` returns an owned
`ScopedObserver{observer,...}`. Set the copied client's
`Options.pool_observer=scope.observer`; restore its old option before
`scope.deinit()`. The observer overrides the Pool default for that session rather
than adding a second counter. Session and detached block probes retain their
observer context until actual native completion/cancellation drain, so dropping
an owned scope immediately after submit is safe. `Recorder.fork(role,operation)`
also provides an independently owned immutable recorder with copied public node
labels. Config's borrowed default observer still requires its owner through Pool
teardown. Native tests drop scopes before response/cancellation retirement and
verify distinct operation labels and exact1/1 counts without leaks.
