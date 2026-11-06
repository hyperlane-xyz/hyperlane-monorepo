# Native asynchronous HTTP

`Multi.init(allocator, Config)!*Multi`, `submit(curl.Request, monotonic_ms)!Id`,
`poll(monotonic_ms)!?Completion`, `cancel(Id)!void`, `deinit()` are owner-thread
APIs. `poll` is nonblocking and drives all active libcurl sockets. A dedicated
I/O owner can marshal concurrent callers through a bounded command queue, as
`relayer/remote_checkpoints.zig` does.

Submit copies URL/body/headers. Optional atomic cancellation flags remain
borrowed until completion/cancel. Completion owns its response; call its deinit.
Cancellation queues exactly one completion; IDs include a generation to reject
stale cancellation after slot reuse. Queued deadlines start at submit, and
remaining time is applied at activation. Capacity includes completed but
unconsumed responses. Reservations include receive/result bodies, fixed bounded
header storage and at most 512 parsed headers. Native libcurl connection/TLS
buffers remain managed by libcurl and its bounded connection limits.

The shared `curl.Transfer` applies identical validation, TLS verification,
redirect prohibition, path preservation, identity encoding, response bounds,
deadlines, cancellation and actual-destination public-address checks to both
synchronous and multi requests. Separate native multi handles and easy pools
prevent trusted connections from bypassing public-only socket checks.

Native tests cover eight stalled configured-first requests alongside eight
healthy later requests; exactly-once cancellation; byte and queue bounds;
queued expiry; stale IDs; allocation failures; body/header caps; redirect
prohibition and private destinations. Set `HYPERLANE_CURL_LIBRARY` to the explicit
library used by the deployment; no production URL is accessed by these tests.
