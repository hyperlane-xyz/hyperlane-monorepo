# Deviations from the TypeScript proxy

Each module owner keeps its own section. No silent gaps.

## scraperdb

- **Column allowlists are static.** `tables.ts` derives columns from
  `scraperdb-schema.graphql` at startup; `tables.zig` hardcodes them and
  `corpus_test.zig` asserts they equal the TS-derived lists (regenerate the
  corpus after a schema edit).
- **Inputs GraphQL coercion cannot produce** are handled deterministically
  rather than reproducing JS runtime accidents: a non-list value for a list
  argument (`distinct_on`, `cursor`, `order_by`) is treated as a one-element
  list (TS would e.g. use a string's `.length`); a non-string `order_by`
  direction fails with `direction.split is not a function`; comparison
  operator names that are `Object.prototype` keys (`constructor`, `toString`)
  are rejected as `Unsupported comparison operator` (TS would render garbage
  SQL). Validation/enum typing makes all of these unreachable over HTTP.
- **`count` result check** requires a safe integer where TS accepts any JS
  number; the SQL always casts `::int`, so results are identical.

## diagnostics

- **Threads instead of one event loop.** Drains, listener connects, notifications
  and send completions interleave at lock boundaries rather than at `await`
  points. Node never fires a timer between two synchronous calls (e.g. four
  `notify()`s or several `subscribe()`s); here the 25ms drain timer can fire
  between them, so a burst may split into two reads. Each read still
  publishes only changed fingerprints, so clients see at most an extra frame
  carrying newer state, never a stale or duplicate one.
- **`stop()` blocks** until the listener connect attempt, the running drain
  and the listener have finished (TS awaits the same promises).
- **Sink contract**: `Completion.complete(sent)` must be called exactly once.
  TS tests use sinks that never complete; the production `sendDiagnostics`
  always completes, which is what this port requires.
- **`z.coerce.number()` on non-scalar row values** (objects, multi-element
  arrays) follows JS `Number()` only for the cases node-pg can produce
  (numbers, numeric strings, null, booleans, empty/one-element arrays).
- **Unavailable notices** are prepared for every subscriber before any is sent
  (TS interleaves compute and send per subscriber); each subscriber's state
  only depends on its own maps, so the frames and retries are identical.

## foundation (core, http, db, main)

- **Metrics:** Node-only `nodejs_*` default metrics are omitted. `process_*`
  series are computed natively with prom-client's names/help/types:
  `process_cpu_{user,system}_seconds_total`, `process_cpu_seconds_total`,
  `process_start_time_seconds`, `process_resident_memory_bytes` everywhere;
  `process_virtual_memory_bytes`, `process_heap_bytes`, `process_open_fds`,
  `process_max_fds` on Linux only (as prom-client). Values naturally differ.
- **HTTP/WebSocket runtime and timeouts:** see the http section below.
- **Fastify request lifecycle is reproduced for this app only:** root CORS
  hook (`origin: true`, strict preflight answered for every path), route
  `onRequest`/handler/error handler/`onSend`/completion. Content-type
  matching implements the built-in `application/json` (secure-json-parse,
  BOM strip) and `text/plain` parsers plus route text types; regex parsers
  and other Fastify features are not implemented (unused).
- **Unread request bodies:** after a response, up to 1 MiB of a
  Content-Length body is drained to keep the connection alive (Node
  `req._dump()` drains without a cap); larger or chunked remainders close the
  connection.
- **libpq instead of node-pg:** connection strings use libpq URI/keyword
  semantics (sslmode etc.), not pg-connection-string. Error messages from the
  server are identical (primary message, SQLSTATE in `code`); client-side
  connection errors use libpq text with the `connection to server ...
failed:` prefix stripped (node-pg says e.g. `connect ECONNREFUSED ...`).
  Timeouts use node-pg's texts (`Connection terminated due to connection
timeout`, `Query read timeout`, `timeout exceeded when trying to connect`).
  A client-side query timeout closes the connection (node-pg keeps it).
- **Dates:** node-pg turns `timestamptz`/`date` (and `timestamp[]`, `date[]`)
  into JS `Date`s; rows carry `JSON.stringify(date)` (ISO, UTC, ms). Values
  without a zone are interpreted as UTC. node-pg uses the process time zone;
  production runs node:alpine (typescript/Dockerfile runner) with no TZ set in
  the infra/helm config, so the process zone is UTC and the output is
  identical in the deployed environment. It differs only if TZ is set to a
  non-UTC zone. `interval[]` elements stay raw text (node-pg
  builds PostgresInterval objects). Point/circle types stay raw text.
- **Prepared statements for unique-key lookups (not client-visible):**
  node-pg sends every parameterised query as an unnamed statement, so it is
  planned for its actual values on every execution. The GraphQL pool instead
  keeps per-connection named statements for `*_by_pk`, selects pinning
  `id`/`msg_id` with `_eq`, the fixed confirmation snapshot, and
  confirmation projections bounded by `msg_id` `_eq`. PostgreSQL may then
  reuse a generic plan. Results are identical: these shapes read at most one
  row per key. A whole-proxy stress run with every statement forced generic
  differed from TS only on non-unique lookups, which stay unnamed. SQL text,
  errors and every other query are unchanged. Errors node-pg cannot produce
  never reach clients:
  - 0A000 after view DDL is re-prepared.
  - 26000/42P05 (for example behind a transaction pooler) are retried
    unnamed. Named statements are switched off for the pool, with one warning,
    at a 42P05 or at a second 26000 within 60 s.
    Backend memory is at most 8 statements (about 15 MB) per connection.
- **Idle connection errors** are detected at checkout (pg-pool reacts to the
  socket event immediately); the log line and replacement behaviour match.
- **Logs:** pino-shaped JSON lines on stdout with the same events/levels;
  `LOG_FORMAT=pretty` prints the message only.
- **Startup failure output:** the error message is printed to stderr and the
  process exits 1 (Node prints a stack trace for the uncaught rejection).

## http (owner: io; supersedes the http bullets in the foundation section)

- **Evented, but not one thread:** sockets live on one epoll/kqueue set served
  by an elastic pool of poller threads (`src/http/IMPLEMENTATION.md`). A hook
  that blocks (database, live's loop) holds its poller while the others keep
  serving, so unlike Node a slow handler does not delay other sockets. Pollers
  are capped at 256; beyond that many simultaneously blocked hooks, ready
  sockets wait (GraphQL admission keeps blocked hooks near 25). No socket cap.
- **requestTimeout covers the head only and fires within one tick:** 10 s from
  the start of a request head (or from accept for a fresh socket) -> Fastify's
  408 client error, checked by a sweep every 250 ms (1/10 of the shortest
  timeout, at most 250 ms). Node checks every 30 s
  (`connectionsCheckingInterval`), so it fires between 10 s and 40 s.
  Measured: Node does not time out a stalled body; neither does the Zig server.
- **Lingering close:** after a `Connection: close` response the socket is
  half-closed and drained until the peer closes, like Node's `socket.end()`,
  but bounded by 10 s (Node waits indefinitely) and cut short when the server
  closes.
- **Stalled clients cost memory, not threads:** a client that stops reading a
  response or never finishes a request body (Node applies no timeout to
  either) parks its socket with its unsent bytes / buffered body, like Node.
  The WebSocket handshake answer (101 or an abort response) is the exception:
  if the socket buffer is full, a 101 tail is queued, but an abort response
  waits for writability on its poller thread.
- **Fastify is reproduced for this app only:** root CORS hook, find-my-way
  static routing (no params/wildcards beyond CORS preflight), route
  `onRequest`/handler/error handler/`onSend`/completion, built-in JSON and
  text parsers plus route text types. Absolute-form URL validation
  approximates WHATWG `new URL` (non-empty host, numeric port).
- **llhttp parity is empirical:** method list, versions, header/URL byte
  rules and header-size accounting were measured (see the HTTP corpus);
  inputs outside the corpus may be accepted or rejected differently.
- **`ws.close(code, reason)`** truncates reasons over 123 bytes and does not
  validate the code, where `ws` throws `RangeError`/`TypeError`; live only
  passes valid codes and short reasons, so this is unreachable.
- **Header count:** like Node's `maxHeadersCount` (2000), extra request
  headers are ignored, not rejected (they still count towards the 16 KiB
  limit).
- **Not measured, from Node/Fastify source:** the 503 answer to requests that
  arrive while closing, and the silent close of an idle keep-alive socket
  after 72 s (the corpus cannot exercise shutdown or a 72 s wait).

## graphql

- **Root-field error collection.** Root fields run concurrently, and errors
  are merged the way graphql-js collects them on a query's first executions
  (verified case by case against TS in `parity/corpus/graphql-errors.mjs`):
  failures without I/O (assertions, argument errors) settle first in document
  order, then I/O-backed fields in completion order; the first non-null
  failure in that order nulls `data` and ends collection. Both roots failing
  with PostgreSQL errors: TS error order is timing-dependent (~75/25 document
  vs reversed in 20 runs, ~50/50 in another 10); Zig also orders I/O errors by
  completion, so it is equally timing-dependent (the corpus compares that
  case's errors as a multiset, `errorsUnordered`). Not emulated:
  a non-null resolver that throws synchronously (only "Diagnostics are not
  configured") prevents graphql-js from starting later root fields.
- **mercurius JIT.** TS behavior changes after a query's 4th execution
  (graphql-jit; mercurius adaptive JIT `minCount: 3`, when event-loop
  utilisation < 0.8); Zig always follows graphql-js — error collection order
  for repeated failing multi-root queries may differ from TS from the 4th
  execution on. Observed: with a non-null I/O-free failure, jit-compiled TS
  also includes nullable I/O errors that settle before the response is
  serialized. Parity (one execution per query) observes graphql-js.
- **JSON-AST fallback.** When a query fails to parse but is valid JSON, mercurius
  executes it as a GraphQL AST. Zig answers `Invalid AST Node: <inspect>.` (200)
  for every such value, which matches graphql-js for non-AST JSON (numbers,
  strings, `{}`, arrays) but not for a hand-written JSON `Document` AST, which TS
  would execute.
- **Type-system definitions in a request.** ExecutableDefinitions and
  KnownTypeNames (SDL mode) are reproduced; other graphql-js rules that also
  visit SDL nodes inside a request (directive/argument rules on SDL) are not.
  The request is rejected either way.
- **`Did you mean` lists.** Implemented with graphql-js `suggestionList`
  (lexical distance + naturalCompare); lowercase folding is ASCII-only, so
  suggestions for non-ASCII input can differ.
- **V8 `JSON.parse` messages** (GET `variables`/`extensions` only) are emulated
  for the common cases (unexpected token with context, end of input, after-JSON,
  property/colon/comma expectations, string/number errors). Rare V8 messages
  (e.g. lone-surrogate inputs) may differ.
- **Lone surrogates** (`"\ud800"` in request JSON) become WTF-8 bytes; UTF-16
  column arithmetic treats them as one unit like JS, but printing them in
  graphql-js messages is not byte-identical.
- **LRU policy.** mercurius' QuickLRU (two generations) is an exact LRU here
  (same capacity, 1024; error LRU likewise). The response-cache prepared
  documents use the same 256/8192-byte bounds. Not observable.
- **Cache key text.** The response-cache key hashes a canonical print of the
  normalized document; it equals graphql-js `print` for executable documents
  but only hit/miss equivalence matters (the key is internal).

- **Execution admission races.** Slots are counted like TS observes them
  (requests yielded on I/O or on a blocked response write; see
  `src/graphql/IMPLEMENTATION.md`). Two requests that pass the preHandler
  check together and race for the last slot at their first I/O: the loser
  gets the preHandler 503, but a `@cached(refresh: true)` loser has already
  dropped its cache entry. Diagnostics resolvers take the slot just before
  the call, so one failing argument validation briefly holds a slot. A
  response write that blocks joins without the bound, so the count can
  exceed the limit by the requests racing at that instant. All need a race
  at exactly the last slot.

## live (`/agents`, `/messages`)

- **Event-loop timing windows.** The loop mutex reproduces "nothing runs between
  awaits", and synchronous prefixes run inline (see `src/live/IMPLEMENTATION.md`),
  but continuations run on pool threads, so wall-clock interleavings differ in
  windows TS fills with microtasks: e.g. a notification arriving between a
  worker timer firing and its drain task starting can join the current batch
  instead of the next one, and a timer-fired drain that already finished is not
  "joined" by a later `flush()` (it runs a fresh, usually empty, drain). Only
  cross-event ordering inside those windows can differ; per-stream ordering,
  cursors and gap checks are unchanged.
- **Integer ranges.** Notification ids/heights and row cursors are parsed as
  i128 (TS: unbounded BigInt). Client cursor values beyond i128 keep their exact
  text (echoed in `subscribed` and error messages) and compare as larger than
  any stored bigint, so behaviour is unchanged; notification payloads beyond
  i128 are rejected as invalid (unreachable from int8 columns).
- **Heartbeat `serverTime`** is computed once per heartbeat sweep (TS: per
  client, within the same millisecond in practice).
- **Send-failure log text.** `send failed: <reason>` uses a fixed reason
  ("WebSocket is not open") instead of the Node socket error message. Logs only;
  the `send_error` metric and termination behaviour match.
- **Upgrades after `stop()`.** TS removes its 'upgrade' listener, leaving Node
  to treat later upgrade requests as plain HTTP; the port destroys the socket
  (or, for an upgrade already past that check, closes it with 1001 "Server
  stopping"). Only reachable during shutdown, between `events.stop()` and HTTP
  close.
- **Test-only limits.** TS tests construct the server with `maxExplorerClients`,
  `heartbeatMs` and sub-minimum `maxCatchUpMs`; Zig unit tests do the same via
  `live.Limits`. Per the lead's decision neither binary exposes them (env surface
  matches TS), so real-PG parity uses production limits.
