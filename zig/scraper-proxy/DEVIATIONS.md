# Deviations from the TypeScript proxy

Every known behaviour difference between the Zig port and the TypeScript
proxy (the oracle). Each entry says what differs, why, and what a client can
observe. Anything not listed here is meant to be identical; a differential
runner that byte-compares both servers against the same PostgreSQL checks
that (kept outside this tree).

## Concurrency model

The proxy runs on threads, not one Node event loop. Where TS relies on
"nothing else runs between two awaits", the port reproduces the observable
rule, not the scheduling.

- **HTTP pollers.** Sockets live on one epoll/kqueue set and one poller
  thread runs at a time. A poller about to block (database wait, pool wait,
  root-field join, marked with `core.blocking`) hands its place to a waiting
  or parked poller, and a monitor hands off for any dispatch stalled more
  than 2 ms without that mark (e.g. live's loop mutex). Unlike Node, a
  blocked handler never delays other sockets. At most 256 poller threads
  (running, blocked and parked); GraphQL admission keeps blocked ones
  near 25. No socket cap. Client impact: none beyond latency.
- **GraphQL execution admission.** TS counts a request against
  `GRAPHQL_MAX_ACTIVE_REQUESTS` from preHandler to response finish, but a
  request that never awaits (cache hit, validation error, any I/O-free
  result written at once) starts and finishes within one event-loop turn, so
  other requests only ever see requests parked on I/O. The port counts
  exactly those: a request takes its slot at its first database or
  diagnostics read, or when its response write blocks, and returns it when
  the response is done; uploads likewise count only while their body is
  still arriving. The 503 decisions match TS except in a race at exactly the
  last slot, which Node cannot have: two requests that both passed the check
  and then reach their first read together; the second gets the same 503 TS
  would have sent at preHandler. Within that race: a `@cached(refresh: true)`
  loser has already dropped its cache entry; a diagnostics request with
  invalid arguments holds a slot for the instant before failing; a blocked
  response write takes its slot without the bound, so the count can exceed
  the limit by the requests racing at that moment.
- **GraphQL root fields run concurrently** on threads, and errors are merged
  the way graphql-js collects them on a query's first execution (checked
  case by case in `parity/corpus/graphql-errors.mjs`): failures without I/O
  (assertions, argument errors) first in document order, then I/O-backed
  fields in completion order; the first non-null failure in that order nulls
  `data` and ends collection. When two roots both fail in PostgreSQL, TS's
  order is timing-dependent (about 75/25 and 50/50 in two samples) and so is
  the port's. Not reproduced: a non-null resolver that throws synchronously
  (only "Diagnostics are not configured") stops graphql-js from starting
  later root fields; here they run.
- **Live event timing windows.** A loop mutex reproduces "nothing runs
  between awaits" and synchronous prefixes run inline
  (`src/live/IMPLEMENTATION.md`). Tasks take the loop mutex for the first
  time in spawn order (as Node runs timers and continuations in order), so a
  drain that fired first still issues its reads first; the remaining
  difference is where a task resumes after a DB read or send completion, in
  windows TS fills with microtasks. Example: a
  notification arriving between a worker timer firing and its drain starting
  can join the current batch instead of the next; a timer-fired drain that
  already finished is not "joined" by a later `flush()` (it runs a fresh,
  usually empty, drain). Per-stream ordering, cursors and gap checks are
  unchanged; only cross-event ordering inside those windows can differ.
- **Diagnostics stream bursts.** Node never fires a timer between two
  synchronous calls (e.g. several `notify()`s); here the 25 ms drain timer
  can fire between them, so a burst may split into two reads. Each read
  publishes only changed fingerprints: a client can see an extra frame with
  newer state, never a stale or duplicate one. Unavailable notices are
  prepared for every subscriber before any is sent (TS interleaves compute
  and send); frames and retries are identical.

## HTTP (Fastify / Node http)

- **Fastify is reproduced for this app only:** root CORS hook
  (`origin: true`, strict preflight answered for every path), find-my-way
  static
  routing, route `onRequest`/handler/error handler/`onSend`/completion, the
  built-in `application/json` (secure-json-parse, BOM strip) and
  `text/plain` parsers plus route text types. Regex parsers, route params and
  other unused Fastify features are not implemented. Absolute-form URL
  validation approximates WHATWG `new URL` (non-empty host, numeric port).
- **llhttp parity is empirical:** method list, versions, header/URL byte
  rules and header-size accounting were measured against Node (HTTP
  corpus); inputs outside the corpus may be accepted or rejected
  differently.
- **requestTimeout covers the head only and is exact:** 10 s from the start
  of a request head (or from accept for a fresh socket), then Fastify's 408,
  fired by a one-shot timer at the deadline. Node checks every 30 s
  (`connectionsCheckingInterval`), so it fires between 10 s and 40 s. Neither
  times out a stalled body.
- **Lingering close** after a `Connection: close` response drains the
  half-closed socket until the peer closes, like Node's `socket.end()`, but
  for at most 10 s (Node: indefinitely) and not past server close.
- **Unread request bodies:** after a response, up to 1 MiB of a
  Content-Length body is drained to keep the connection alive (Node's
  `req._dump()` has no cap); larger or chunked remainders close the
  connection.
- **Stalled clients cost memory, not threads:** a client that stops reading
  a response or never finishes a body (Node has no timeout for either) parks
  its socket with its unsent bytes or buffered body, like Node. Exception: a
  WebSocket handshake abort response waits for writability on its poller
  thread if the socket buffer is full.
- **Header count:** like Node's `maxHeadersCount` (2000), extra request
  headers are ignored, not rejected (they still count towards the 16 KiB
  limit).
- **Not measured, taken from Node/Fastify source:** the 503 for requests
  arriving while the server closes, and the silent close of an idle
  keep-alive socket after 72 s.

## GraphQL (mercurius / graphql-js)

- **mercurius JIT.** From a query's 4th execution TS switches to graphql-jit
  (adaptive `minCount: 3`, when event-loop utilisation < 0.8); the port
  always follows graphql-js. Only error collection order for repeated,
  failing multi-root queries can differ (jit-compiled TS also includes
  nullable I/O errors that settle before a non-null I/O-free failure is
  serialized).
- **JSON-AST fallback.** When a query fails to parse but is valid JSON,
  mercurius executes it as a GraphQL AST. The port answers
  `Invalid AST Node: <inspect>.` (200) for every such value: identical for
  non-AST JSON
  (numbers, strings, `{}`, arrays), different for a hand-written JSON
  `Document`, which TS would execute.
- **Type-system definitions in a request.** ExecutableDefinitions and
  KnownTypeNames are reproduced; other graphql-js rules that also visit SDL
  nodes (directive/argument rules) are not. The request is rejected either
  way; the error list can differ.
- **`Did you mean` lists** use graphql-js `suggestionList`, but lowercase
  folding is ASCII-only, so suggestions for non-ASCII input can differ.
- **V8 `JSON.parse` messages** (GET `variables`/`extensions`) are emulated
  for the common cases; rare V8 messages (e.g. lone-surrogate inputs) may
  differ.
- **Lone surrogates** (`"\ud800"` in request JSON) become WTF-8 bytes;
  locations count them as one UTF-16 unit like JS, but printing them in
  graphql-js messages is not byte-identical.
- **Caches (not observable).** mercurius' two-generation QuickLRU is an
  exact LRU of the same capacity (1024, error LRU likewise); the response
  cache's prepared documents keep TS's 256 / 8192-byte bounds; the cache key
  hashes a canonical print of the normalised document (only hit/miss
  equivalence matters).

## Database (node-pg / pg-pool)

- **libpq instead of node-pg.** Connection strings use libpq URI/keyword
  semantics (sslmode etc.), not pg-connection-string. Server errors are
  identical (message, SQLSTATE `code`). Client-side connection errors use
  libpq text with the `connection to server ... failed:` prefix stripped
  (node-pg: e.g. `connect ECONNREFUSED ...`). Timeouts use node-pg's texts
  (`Connection terminated due to connection timeout`, `Query read timeout`,
  `timeout exceeded when trying to connect`). A client-side query timeout
  closes the connection (node-pg keeps it).
- **Dates.** node-pg turns `timestamptz`/`date` (and their arrays) into JS
  `Date`s in the process time zone; the port renders `JSON.stringify(date)`
  (ISO, UTC, ms) and reads zone-less values as UTC. Production runs with no
  `TZ` (UTC), so output is identical there; it differs only under a non-UTC
  `TZ`. `interval[]` elements, point and circle stay raw text (node-pg builds
  objects for intervals).
- **JIT disabled per session (not client-visible).** Every connection
  starts with `-c jit=off`, placed before any `options` in the URL so a URL
  can override it. PostgreSQL's JIT compiles the confirmation snapshot and
  projection (plan cost just over `jit_above_cost`) for 12 and 52-62 ms, to
  save execution time those queries don't have: they run in 0.2 and 15 ms
  without it. On the 1M-message bench DB every workload query is as fast or
  faster with JIT off, and results are identical. TS can adopt the same
  setting; the benchmark report shows a TS-with-JIT-off control row.
- **Prepared statements for unique-key lookups (not client-visible).**
  node-pg plans every parameterised query for its values (unnamed
  statements). The GraphQL pool keeps per-connection named statements for
  `*_by_pk`, selects pinning `id`/`msg_id` with `_eq`, the fixed confirmation
  snapshot and confirmation projections bounded by `msg_id` `_eq`, so
  PostgreSQL may reuse a generic plan. Key lookups read at most one row per
  key, and the snapshot's arrays only feed `= ANY`/`unnest`, so a different
  plan cannot change any response (a stress run forcing every statement
  generic differed only on non-unique lookups, which stay unnamed). A text is
  prepared on its second use; a full cache (8 per connection) evicts only an
  entry idle for 64 named queries, so one-off shapes cost no more than
  node-pg's unnamed path. Parse, and the switch to `plan_cache_mode=auto`
  these statements need (sessions start with `force_custom_plan`), are
  pipelined with the execute, so neither adds a round trip. All other
  queries are unnamed statements, as in node-pg.
  SQL text and errors are unchanged; errors node-pg cannot produce never
  reach clients: 0A000 after view DDL is re-prepared; 26000/42P05 (e.g.
  behind a transaction pooler) are retried unnamed, and named statements are
  switched off for the pool, with one warning, on a 42P05 or a second 26000
  within 60 s. Backend memory: at most 8 statements (about 15 MB) per
  connection.
- **Idle connection errors** are detected at checkout (pg-pool reacts to
  the socket event at once); the log line and replacement behaviour match.
- **Inputs GraphQL coercion cannot produce** are handled deterministically
  instead of reproducing JS accidents: a non-list value for a list argument
  (`distinct_on`, `cursor`, `order_by`) is treated as a one-element list; a
  non-string `order_by` direction fails with
  `direction.split is not a function`; operator names that are
  `Object.prototype` keys (`constructor`,
  `toString`) are rejected as `Unsupported comparison operator` (TS would
  render invalid SQL). Validation makes all of these unreachable over HTTP.
- **`count`** requires a safe integer where TS accepts any JS number; the SQL
  casts `::int`, so results are identical.
- **Diagnostics `z.coerce.number()`** on non-scalar row values follows JS
  `Number()` only for what node-pg can produce (numbers, numeric strings,
  null, booleans, empty/one-element arrays).
- **Column allowlists are static** (`tables.zig`) where TS derives them from
  `scraperdb-schema.graphql` at startup; `corpus_test.zig` asserts they
  match, so a schema edit needs the corpus regenerated.

## WebSockets (`/agents`, `/messages`)

- **Integer ranges.** Notification ids/heights and row cursors are i128 (TS:
  unbounded BigInt). Client cursors beyond i128 keep their exact text
  (echoed in `subscribed` and errors) and compare as larger than any stored
  bigint, so behaviour is unchanged; notification payloads beyond i128 are
  rejected as invalid (unreachable from int8 columns).
- **Inline write errors** are detected during the send (the socket is
  terminated and `send_error` counted then); TS learns of a synchronous
  write error in the next tick's callback. Same termination, same single
  count; only the moment differs.
- **Coalesced writes.** Frames that Node writes one `socket.write` at a
  time within one event-loop tick (event and block frames, Explorer
  upserts) are written per socket in one vectored write at the end of the
  emulated tick. The WebSocket messages and their order are unchanged, and
  so are `bufferedAmount`, `outbound_pending_bytes`, limit decisions and
  write-callback order as seen from outside the tick (no `/metrics` read or
  other event runs inside a tick; a randomized differential test checks this
  against one write per frame). Only TCP segment boundaries differ.
- **Heartbeat `serverTime`** is computed once per heartbeat sweep (TS: per
  client, within the same millisecond in practice).
- **Upgrades after `stop()`.** TS removes its 'upgrade' listener, so Node
  treats later upgrade requests as plain HTTP; the port destroys the socket
  (or closes an upgrade already past that check with 1001 "Server
  stopping"). Only reachable during shutdown.
- **`ws.close(code, reason)`** truncates reasons over 123 bytes and does not
  validate the code (`ws` throws); the proxy only passes valid codes and
  short reasons, so this is unreachable.
- **Limits are not configurable beyond TS's env surface.** TS tests pass
  `maxExplorerClients`, `heartbeatMs` and sub-minimum `maxCatchUpMs` to the
  server constructor; the port's tests do the same through `live.Limits`,
  and neither binary exposes them.

## Metrics, logs, process

- **Metrics.** Node-only `nodejs_*` default metrics are omitted. `process_*`
  series are computed natively with prom-client's names/help/types:
  `process_cpu_{user,system}_seconds_total`, `process_cpu_seconds_total`,
  `process_start_time_seconds`, `process_resident_memory_bytes` everywhere;
  `process_virtual_memory_bytes`, `process_heap_bytes`, `process_open_fds`,
  `process_max_fds` on Linux only (as prom-client). Values naturally differ.
- **Logs** are pino-shaped JSON lines on stdout with the same events and
  levels (`LOG_FORMAT=pretty` prints the message only); exact bytes are not
  part of the contract. Lines from different threads may interleave in a
  different order. `send failed: <reason>` uses the fixed reason
  "WebSocket is not open" instead of the Node socket error text (the
  `send_error` metric and termination match).
- **Startup failure:** the error message goes to stderr and the process
  exits 1 (Node prints a stack trace for the uncaught rejection).
