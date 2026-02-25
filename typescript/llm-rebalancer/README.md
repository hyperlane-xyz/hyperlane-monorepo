# LLM-Based Warp Route Rebalancer

An LLM agent that replaces coded rebalancing strategies with prose-driven decision-making, using [Pi](https://github.com/badlogic/pi-mono) as the agent runtime.

## Architecture

**Paradigm shift**: Instead of `Monitor → Strategy → Rebalancer → ActionTracker` with hard-coded strategies (Weighted, MinAmount, CollateralDeficit), the LLM agent reads a prose strategy description (AGENTS.md), observes on-chain state via typed tools, and decides what to do.

```
┌─────────────────────────────────────────────────┐
│  Pi Agent Runtime                                │
│                                                  │
│  AGENTS.md (strategy + injected previous context)│
│         ↓                                        │
│  ┌──────────┐  ┌─────────────────────────┐       │
│  │ Reasoning │  │ Custom Tools (ethers.js) │      │
│  │ (LLM)    │→ │ get_balances             │      │
│  └──────────┘  │ check_hyperlane_delivery │      │
│         ↓      │ get_chain_metadata       │      │
│  ┌───────────┐ │ save_context             │      │
│  │ Skills    │ ├─────────────────────────┤       │
│  │ (bash/    │ │ Coding Tools             │      │
│  │  cast)    │ │ bash, read, write        │      │
│  └───────────┘ └─────────────────────────┘       │
│         ↓                                        │
│  ┌──────────────────────┐                        │
│  │ ContextStore         │ (prose summaries,      │
│  │ InMemory / SQLite    │  inflight tracking)    │
│  └──────────────────────┘                        │
└─────────────────────────────────────────────────┘
         ↕ ethers / cast call/send
┌─────────────────────────────────────────────────┐
│  On-chain: Warp tokens, bridges, mailboxes       │
└─────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Typed tools for reads, skills for execution**: Deterministic on-chain reads (balances, delivery checks) use typed ethers.js tools. Execution (rebalance, bridge, deposit) uses bash/cast skills for flexibility.
- **Per-bridge skills**: Each bridge type has its own skill (mock-bridge, CCTP, LiFi) with a shared `submit-transaction` skill for signing and receipt parsing. The agent reads the appropriate skill based on the deployment's bridge type.
- **Context via prose summaries**: Each cycle ends with `save_context` — LLM writes a terse summary of pending actions, command templates, and state. Used for crash recovery and inter-cycle state.
- **Persistent session across cycles**: A single Pi session is reused across rebalancer cycles. Conversation history accumulates, so the agent remembers skill content, command templates, and chain metadata from previous cycles — eliminating redundant skill discovery.
- **Adaptive polling**: Short interval when actions are pending, long interval when balanced.
- **No MockActionTracker**: The sim's `MockInfrastructureController` auto-tracks rebalances from Dispatch events.
- **Event streaming**: Pi session events mapped to structured `RebalancerAgentEvent` types for observability.

## Package Structure

```
typescript/llm-rebalancer/
├── package.json
├── tsconfig.json
├── skills/                              # Pi skills (execution via bash/cast)
│   ├── submit-transaction/SKILL.md      # Shared: foundry keystore signing + receipt parsing
│   ├── rebalance-mock-bridge/SKILL.md   # Rebalance via MockValueTransferBridge (sim)
│   ├── rebalance-cctp/SKILL.md          # Rebalance via CCTP bridge (production)
│   ├── rebalance-lifi/SKILL.md          # Rebalance via LiFi (production, off-chain)
│   ├── inventory-deposit/SKILL.md       # Deposit inventory into deficit chain
│   └── bridge-tokens/SKILL.md           # Move inventory between chains via bridge
├── src/
│   ├── index.ts
│   ├── agent.ts                         # RebalancerAgent class (persistent session)
│   ├── config.ts                        # Config types
│   ├── context-store.ts                 # ContextStore interface + InMemory/Sqlite stores
│   ├── events.ts                        # RebalancerAgentEvent types
│   ├── prompt-builder.ts                # Generates AGENTS.md from config + context
│   ├── tools/                           # Typed Pi custom tools (ethers.js)
│   │   ├── index.ts                     # buildCustomTools() factory
│   │   ├── get-balances.ts              # Read collateral balances
│   │   ├── get-chain-metadata.ts        # Chain config metadata
│   │   ├── check-hyperlane-delivery.ts  # Mailbox.delivered() check
│   │   └── save-context.ts              # Persist LLM context summaries
│   └── (LLMRebalancerRunner lives in rebalancer-sim/src/runners/)
├── scripts/
│   └── run.ts                           # Production entry point
└── CHANGELOG.md                         # Iteration log
```

## Custom Tools

Typed tools provide deterministic, fast on-chain reads. The LLM calls these directly — no bash/cast needed.

| Tool                       | Purpose                                       | Returns                          |
| -------------------------- | --------------------------------------------- | -------------------------------- |
| `get_balances`             | Read collateral balances per chain via ethers | Balance + share % per chain      |
| `get_chain_metadata`       | Chain config (RPC, domain, addresses, bridge) | JSON metadata map                |
| `check_hyperlane_delivery` | Check if Hyperlane message delivered on dest  | `{ messageId, delivered: bool }` |
| `save_context`             | Persist prose summary for next cycle          | Confirmation                     |

## Skills

Skills are `SKILL.md` files that teach the agent execution capabilities via bash/cast. Copied to `.pi/skills/` at runtime. The agent reads them on-demand when it needs to execute an action.

| Skill                   | Purpose                                                             | Tools             |
| ----------------------- | ------------------------------------------------------------------- | ----------------- |
| `submit-transaction`    | Foundry keystore signing, receipt parsing, messageId extraction     | bash, read        |
| `rebalance-mock-bridge` | Call `rebalance()` on warp tokens via MockValueTransferBridge (sim) | bash, read        |
| `rebalance-cctp`        | Rebalance via CCTP bridge (production)                              | bash, read        |
| `rebalance-lifi`        | Rebalance via LiFi bridge aggregator (production)                   | bash, read        |
| `inventory-deposit`     | Approve + `transferRemote` from deficit chain                       | bash, read, write |
| `bridge-tokens`         | Move inventory between chains via external bridge                   | bash, read, write |

## Session Reuse

The `RebalancerAgent` class holds a persistent Pi session across cycles:

```typescript
const agent = await RebalancerAgent.create(opts);

// Each call reuses the same session — conversation history accumulates
await agent.runCycle(); // First cycle: discovers skills, reads SKILL.md
await agent.runCycle(); // Subsequent: skips skill reading, uses memory
await agent.runCycle();

agent.dispose();
```

Benefits:

- **Skill discovery once**: Agent reads `.pi/skills/rebalance-*/SKILL.md` on first rebalance, remembers for all subsequent cycles
- **Command template caching**: Agent saves `tpl:` field in context with the `cast send` template, reuses with `get_chain_metadata` for new addresses
- **Parallel tool calls**: Agent calls `check_hyperlane_delivery` + `get_balances` simultaneously when both are needed
- **Crash recovery**: On session failure, agent recreates session with latest context from `ContextStore`

The legacy `runRebalancerCycle()` function still exists for one-shot usage.

## Rebalancer-Sim Integration

`LLMRebalancerRunner` implements `IRebalancerRunner`:

1. **initialize()**: Creates temp work dir, copies skills, writes `rebalancer-config.json`, builds custom tools with ethers closures
2. **start()**: Creates persistent `RebalancerAgent` session, begins adaptive polling loop
3. **stop()**: Disposes agent, clears timer, awaits in-flight cycle, cleans up temp dir

Extended timeouts and timing are applied when `REBALANCERS=llm`:

- `transferTimestampScale: 10` (stretches transfer timing for slow LLM cycles)
- `userTransferDeliveryDelay: 5_000` (5s vs 100ms)
- `deliveryTimeoutMs: 300_000` (5 min)
- `idleTimeoutMs: 180_000` (3 min)
- Mocha timeout: 900s

### Running in sim

```bash
# Requires OPENCODE_API_KEY (preferred), ANTHROPIC_API_KEY, or ANTHROPIC_TEST_API_KEY in environment
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "extreme-drain"

# Compare against coded rebalancers
REBALANCERS=simple,production,llm pnpm -C typescript/rebalancer-sim test --grep "extreme-drain"
```

## Production Usage

### Prerequisites

- [Foundry](https://book.getfoundry.sh/) installed (`cast` CLI available)
- Node.js 18+
- An LLM API key (OpenCode Zen preferred, Anthropic also supported)

### Setup

1. **Environment variables**:

```bash
export REBALANCER_KEY=0x...        # Private key for the rebalancer wallet
export OPENCODE_API_KEY=...        # OpenCode Zen API key (default provider)
# OR
export ANTHROPIC_API_KEY=sk-...    # Anthropic API key (use with LLM_PROVIDER=anthropic LLM_MODEL=claude-haiku-4-5)
```

2. **Run**:

```bash
tsx typescript/llm-rebalancer/scripts/run.ts config.json
```

On startup, the script:

- Imports `REBALANCER_KEY` into a foundry keystore (the agent uses `--account rebalancer --password ''` for all `cast send` commands — the private key is never exposed to the LLM)
- Writes `rebalancer-config.json` (sans private key) for agent reference
- Creates a persistent `RebalancerAgent` session
- Starts the polling loop with context persistence in SQLite (`rebalancer-context.db`)
- On session failure, automatically recreates with latest context

### Config file format

```json
{
  "chains": {
    "ethereum": {
      "chainName": "ethereum",
      "domainId": 1,
      "rpcUrl": "https://...",
      "mailbox": "0x...",
      "warpToken": "0x...",
      "collateralToken": "0x...",
      "bridge": "0x..."
    }
  },
  "rebalancerAddress": "0x...",
  "strategy": {
    "type": "prose",
    "text": "Maintain equal distribution across chains with ±15% tolerance."
  },
  "pollingIntervalMs": 30000,
  "model": "claude-haiku-4-5",
  "dbPath": "rebalancer-context.db"
}
```

### Transaction signing

The rebalancer uses a **foundry keystore** for transaction signing. The private key is imported once at startup and never passed to the LLM agent directly. All `cast send` commands use:

```bash
--account rebalancer --password ''
```

This is enforced by the `submit-transaction` skill and referenced in all execution skills.
