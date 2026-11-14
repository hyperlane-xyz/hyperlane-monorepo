# Native scraper proxy (Zig)

A Zig 0.15.2 port of [`typescript/scraper-proxy`](../../typescript/scraper-proxy),
built as a drop-in replacement: same environment variables, routes, status codes,
headers, GraphQL responses, WebSocket frames and `/metrics` series. The TypeScript
service remains the reference and the production deployment; nothing here is
deployed.

Known behavioural differences are listed in [DEVIATIONS.md](DEVIATIONS.md). Anything
not listed there is expected to match the TypeScript service byte for byte.

## Build and run

Requires Zig 0.15.2 and libpq (`brew install libpq` on macOS, `libpq-dev` on
Debian). `build.sh` finds the compiler via `$ZIG`, then `PATH`, and works around the
macOS SDK issue Zig 0.15.2 has with recent Xcode releases.

```sh
./build.sh                       # zig-out/bin/scraper-proxy, ReleaseFast
DATABASE_URL=postgresql://... ./zig-out/bin/scraper-proxy
```

Configuration is identical to the TypeScript service (`DATABASE_URL`,
`DATABASE_READ_REPLICA_URL`, `DIAGNOSTICS_DATABASE_URL`, `PORT`, …, plus
`.env` files via the same dotenv-flow rules).

## Test

```sh
./build.sh test --summary all    # every module, Debug
./build.sh test-graphql          # one module: core, db, http, scraperdb,
                                 # diagnostics, graphql, live
```

Tests that need PostgreSQL are skipped unless `SCRAPER_PROXY_TEST_DATABASE_URL`,
`SCRAPER_TEST_DATABASE_URL` or `DIAGNOSTICS_TEST_DATABASE_URL` point at a disposable
database with the scraper schema (`cargo run --release -p migration --bin init-db`
in `rust/main`).

## Fixtures

Several tests compare against output recorded from the TypeScript service. The
generators live next to their fixtures (`src/*/testdata/`, `src/graphql/tools/`)
and import the TypeScript sources directly, so build the TS package first and run
them with its dependencies available, for example:

```sh
pnpm -C typescript/scraper-proxy build
ln -s ../../typescript/scraper-proxy/node_modules zig/scraper-proxy/node_modules
node zig/scraper-proxy/src/graphql/tools/gen-validation-fixtures.mjs
```

## Layout

| Module            | Ports                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `src/core`        | config, logging, JSON (`JSON.stringify`-exact), Prometheus metrics                                        |
| `src/db`          | libpq pool, node-pg value conversion, LISTEN/NOTIFY                                                       |
| `src/http`        | HTTP/1.1 server with Node/Fastify behaviour, CORS, WebSocket server                                       |
| `src/graphql`     | GraphQL parser, validator and executor (graphql-js/mercurius behaviour), response cache, `/graphql` route |
| `src/scraperdb`   | SQL builder and scraper queries, including provisional confirmations                                      |
| `src/live`        | `/agents` and `/messages` streams                                                                         |
| `src/diagnostics` | relayer diagnostics service, reducer and stream                                                           |
