# LLM Rebalancer Changelog

## 2025-02-23: Session Reuse + Parallel Tool Calls

**`RebalancerAgent` class with persistent Pi session across cycles.**

Before: fresh Pi session per cycle. Agent re-discovered skills, re-read SKILL.md, re-explored filesystem every rebalance cycle (~25-35s per execution cycle).

After: single session reused across all cycles. Agent remembers skills, command templates, chain metadata from conversation history. Skill reading only on first rebalance.

- Added `RebalancerAgent` class (`agent.ts`) — `create()` + `runCycle()` + `dispose()`
- Updated `LLMRebalancerRunner` to create agent once in `start()`, reuse across cycles
- Updated `scripts/run.ts` for persistent session with crash recovery
- Added parallel tool call hint to cycle prompt (`check_delivery` + `get_balances` simultaneously)

Results (extreme-accumulate scenario): 109s/4 rebalances (was 132s/3 rebalances) — 17% faster with more work done.

## 2025-02-23: Skill Directory Hint + Template Caching

**Prompt optimization to reduce skill discovery overhead.**

- Added `.pi/skills/` directory hint to system prompt — agent goes directly to skills instead of searching filesystem
- Added `tpl:` field instruction — agent caches `cast send` command template in `save_context` with placeholders (`<SOURCE_WARP>`, `<DEST_DOMAIN>`, `<AMOUNT>`, `<BRIDGE>`, `<RPC>`)
- Subsequent cycles use template + `get_chain_metadata` to build commands, skip skill reading

## 2025-02-23: Per-Bridge Skills + Prompt Trim + Sim Timing

**Split monolithic execute-rebalance skill into per-bridge skills. Trimmed system prompt. Scaled sim timing for LLM.**

Problems solved:

1. Single `execute-rebalance` skill bundled all bridge types (mock, CCTP, LiFi) — confusing for Haiku
2. `wallet-setup` skill duplicated signing info across all execution skills
3. System prompt redundantly listed tools and skills (Pi injects these automatically)
4. Sim timing tuned for ms-speed coded rebalancers, not 15-20s LLM cycles

Changes:

- New `submit-transaction/SKILL.md` — shared signing, receipt parsing, messageId extraction
- New `rebalance-mock-bridge/SKILL.md` — sim-only MockValueTransferBridge
- New `rebalance-cctp/SKILL.md` — production CCTP bridge
- New `rebalance-lifi/SKILL.md` — production LiFi bridge aggregator
- Deleted `execute-rebalance/SKILL.md` and `wallet-setup/SKILL.md`
- Trimmed `prompt-builder.ts` — removed redundant Tools, Skills, Execution sections (~1500 → ~500 tokens)
- Added `transferTimestampScale` to SimulationEngine (stretches transfer timing for slow rebalancers)
- LLM sim timing: 5s delivery delay, 10x timestamp scale, 300s delivery timeout, 180s idle timeout
- Mocha timeout: 900s for LLM tests

Results: balanced cycles dropped from ~28s to ~5s. All 6 scenarios pass at 100% completion.

## 2025-02-22: Foundry Keystore + Haiku Default

- Foundry keystore signing (`--account rebalancer --password ''`) instead of passing private key
- Default model changed to `claude-haiku-4-5` (faster, cheaper, sufficient for rebalancing)
- `wallet-setup` skill for signing reference

## 2025-02-21: Production-Ready LLM Rebalancer Runner

- `LLMRebalancerRunner` implementing `IRebalancerRunner` for sim integration
- Temp work dir with skills copy, config JSON, keystore setup
- Adaptive polling (short interval when pending, long when balanced)
- `ContextStore.clear()` on initialize to prevent stale context

## 2025-02-20: Typed Tools + Context Persistence

**Replaced SQLite with typed custom tools and `ContextStore` interface.**

- `get_balances` — ethers.js tool for deterministic balance reads
- `get_chain_metadata` — chain config metadata tool
- `check_hyperlane_delivery` — Mailbox.delivered() check tool
- `save_context` — persist prose summaries for inter-cycle state
- `InMemoryContextStore` for sim, `SqliteContextStore` for production
- Removed SQLite dependency from core package

## 2025-02-19: Initial Implementation

- Pi agent session creation and cycle execution
- AGENTS.md system prompt generation from config + strategy + context
- Prose-driven rebalancing strategy (weighted, minAmount, or free-form prose)
- Event streaming via `RebalancerAgentEvent` types
