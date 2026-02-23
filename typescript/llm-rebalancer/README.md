# @hyperlane-xyz/llm-rebalancer

Skill-first LLM rebalancer prototype for classic and multi-collateral warp routes.

## Start

1. Create markdown config (see `example.config.md`).
2. Set signer envs.
3. Set `LLM_REBALANCER_CONFIG_FILE`.
4. Run `pnpm -C typescript/llm-rebalancer start:dev`.

## Runtime shape

- Periodic loop.
- `observe` -> inflight -> read prior SQL context -> `global-netting` plan -> execute -> reconcile.
- Durable SQL state via SQLite or Postgres adapters.

## DB URLs

- SQLite: `sqlite:///absolute/path/to/file.db`
- Postgres: `postgres://user:pass@host:5432/db`

## Notes

- Domain operations are skills.
- Typed tools are limited to DB/log I/O.
- Planner retries on failure (`retry-only`).

## Debugging

Inspect persisted run state and last failed run logs:

```bash
LLM_REBALANCER_DB_URL=sqlite:///absolute/path/to/rebalancer.db \
pnpm -C /Users/nambrot/devstuff/hyperlane-monorepo/typescript/llm-rebalancer inspect
```
