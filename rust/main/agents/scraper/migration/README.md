# Running scraper migrations

From `rust/main`, with `DATABASE_URL` set to the intended database:

```sh
cargo run --release -p migration --bin init-db
```

This single command applies pending transactional migrations, then creates and
verifies the raw-dispatch reconciliation, raw-dispatch native-sequence, delivery
scope, and Merkle block-height indexes concurrently. It works for both empty and
existing DBs. Reruns retain matching valid indexes and reject invalid or
conflicting definitions. If index setup fails, the schema migrations stay
committed; repair the reported index and rerun the same command. Concurrent
indexes are independently managed and survive schema rollback.

For migration development and rollback operations, the SeaORM CLI remains
available from this directory:

```sh
cargo run -- migrate generate MIGRATION_NAME
cargo run -- up
cargo run -- up -n 10
cargo run -- down
cargo run -- down -n 10
cargo run -- fresh
cargo run -- refresh
cargo run -- reset
cargo run -- status
```

## Merkle block-height index

`init-db` also installs `merkle_insertion_block_height` on
`merkle_tree_insertion(domain, block_number)`. Automatic cutover selection and the
first-start overlap check need confirmed legacy rows as well as provisional rows;
the existing partial `merkle_insertion_unconfirmed` index cannot serve them.

## Event scope indexes

`store_deliveries` computes a scoped `MAX(id)` before writing
(`latest_deliveries_id` over `domain` + `destination_mailbox`). The existing
mailbox-only index cannot directly seek the highest ID within a scope.

Inspect `pg_indexes` for an equivalent index installed outside migrations before
adding this B-tree index with the operational binary:

- `delivered_message_domain_mailbox_id_idx`:
  `delivered_message(domain, destination_mailbox, id)`

The message-table candidate `message(origin, origin_mailbox, id)` is deferred:
`store_dispatched_messages` counts affected rows instead of issuing scoped
`MAX(id)`/`COUNT` queries, so no current scraper query justifies maintaining it.

From `rust/main`, with `DATABASE_URL` set to the intended database:

```sh
cargo run --release -p migration --bin create-event-scope-indexes
```

The scraper-proxy's legacy gas payment replay pages one paymaster's rows by ID.
Without a matching index, PostgreSQL can combine the domain and paymaster indexes
and sort every remaining row in the range for each page:

- `gas_payment_domain_paymaster_id_idx`:
  `gas_payment(domain, interchain_gas_paymaster, id)`

```sh
cargo run --release -p migration --bin create-gas-payment-scope-index
```

`init-db` runs these automatically after SeaORM migrations commit: PostgreSQL
forbids `CREATE INDEX CONCURRENTLY` inside a transaction. The binary retains
existing indexes and verifies that each index is a valid, ready, nonpartial
B-tree with the expected table and keys. Reruns accept a matching valid index. If
an interrupted concurrent build leaves an invalid index, or its name belongs to
another definition, the command fails instead of treating `IF NOT EXISTS` as
success. Inspect `pg_index` and `pg_get_indexdef` and repair the named index
explicitly before retrying; the command never drops indexes.

Concurrent builds permit normal writes but consume database I/O, CPU, disk and
WAL, and can wait for existing transactions. Schedule the build accordingly and
inspect its progress through `pg_stat_progress_create_index`. The additional
index also adds ongoing insert/update maintenance and storage cost.

### Local plan evidence

For a reproducible synthetic probe, run the SQL below **only in an empty,
disposable PostgreSQL database**; it creates one million rows:

```sh
psql "$LOCAL_DATABASE_URL" -v ON_ERROR_STOP=1 -f agents/scraper/migration/benchmarks/event_scope_indexes.sql
```

The fixture has one million delivery rows, a 32-byte mailbox and 256-byte payload.
The target scope owns the oldest 100,000 rows, followed by 900,000 rows from another
scope. It models an inactive/backfill scope behind a busy scope. This is a reduced
schema containing the query-relevant existing index, not a production copy.

On local PostgreSQL 16, before adding the index, the scoped `MAX` query scanned the
primary key backwards and filtered out 900,000 rows, touching 42,422 shared buffers.
Afterward, it used a scoped index-only seek returning one row with four shared
buffers. Counting IDs above 99,000 changed from scanning 100,000 scoped entries and
filtering 99,000 to scanning only the 1,000 matching entries. The additional index
occupied approximately 65 MiB in this fixture. These are synthetic plan/operation measurements,
not production latency or storage predictions. Index-only heap access also depends
on visibility-map coverage; ongoing writes may require heap fetches.

Slow production logs motivated this work, but logs alone do not prove an index
caused those latencies. Verify installed definitions, query plans and live behavior
separately after any authorized rollout.
