# Native asynchronous HTTP

`Multi.init(allocator, Config)!*Multi`, `submit(curl.Request, monotonic_ms)!Id`,
`poll(monotonic_ms)!?Completion`, `advance(monotonic_ms)!?Completion`,
`wait(monotonic_ms, max_wait_ms)!void`, `cancel(Id)!void`, `deinit()` are
owner-thread APIs; `wakeup()` is thread-safe and level-triggered. A dedicated
I/O owner can marshal concurrent callers through a bounded command queue, as
`relayer/remote_checkpoints.zig` does.

The driver is event-driven (`curl_multi_socket_action` with
`CURLMOPT_SOCKETFUNCTION`/`TIMERFUNCTION`). One level-triggered epoll (Linux) or
kqueue (macOS) set per Multi holds the sockets of both trust caches and an
eventfd/`EVFILT_USER` wakeup. `wait` makes one kernel wait until readiness,
libcurl's timer, the earliest request deadline, `wakeup` or its bound. `poll`
dispatches only ready sockets (gathered by the last `wait`, else by one
nonblocking harvest) and an expired libcurl timer; idle live transfers cost
nothing. `advance` skips that harvest, for owners that always `wait` when idle
(`evm/pool.zig`). Connection sockets are tracked through
`CURLOPT_SOCKOPTFUNCTION`/`CLOSESOCKETFUNCTION`: an idle keepalive socket keeps
its read registration (dropped only if the peer closes it), so reuse makes no
epoll_ctl/kevent change. Counters `waits`, `harvests`, `dispatches` and
`registrations` expose the work.

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
healthy later requests; per-transfer syscalls/waits/dispatches that do not grow
with 24 live idle transfers; level-triggered wakeups; exactly-once cancellation; byte and queue bounds;
queued expiry; stale IDs; allocation failures; body/header caps; redirect
prohibition and private destinations. Set `HYPERLANE_CURL_LIBRARY` to the explicit
library used by the deployment; no production URL is accessed by these tests.
