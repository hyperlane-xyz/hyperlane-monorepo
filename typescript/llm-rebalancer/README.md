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
│  │ InMemory / Postgres  │  inflight tracking)    │
│  └──────────────────────┘                        │
└─────────────────────────────────────────────────┘
         ↕ ethers / cast call/send
┌─────────────────────────────────────────────────┐
│  On-chain: Warp tokens, bridges, mailboxes       │
└─────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Typed tools for reads, skills for execution**: Deterministic on-chain reads (balances, delivery checks) use typed ethers.js tools. Execution (rebalance, bridge, deposit) uses bash/cast skills for flexibility.
- **Context via prose summaries**: Each cycle ends with `save_context` — LLM writes a prose summary of pending actions and state. Injected into the next cycle's system prompt as "Previous Context".
- **Fresh session per cycle**: Each rebalancer cycle creates a new Pi session. ContextStore provides continuity across cycles.
- **Adaptive polling**: Short interval when actions are pending, long interval when balanced.
- **No MockActionTracker**: The sim's `MockInfrastructureController` auto-tracks rebalances from Dispatch events.
- **Event streaming**: Pi session events mapped to structured `RebalancerAgentEvent` types for observability.

## Package Structure

```
typescript/llm-rebalancer/
├── package.json
├── tsconfig.json
├── skills/                          # Pi skills (execution via bash/cast)
│   ├── execute-rebalance/SKILL.md   # On-chain rebalance via bridge
│   ├── inventory-deposit/SKILL.md   # Deposit inventory into deficit chain
│   └── bridge-tokens/SKILL.md       # Mock bridge (sim) or LiFi (prod)
├── src/
│   ├── index.ts
│   ├── agent.ts                     # Pi session creation + cycle invocation
│   ├── config.ts                    # Config types
│   ├── context-store.ts             # ContextStore interface + InMemoryContextStore
│   ├── events.ts                    # RebalancerAgentEvent types
│   ├── prompt-builder.ts            # Generates AGENTS.md from config + context
│   ├── tools/                       # Typed Pi custom tools (ethers.js)
│   │   ├── index.ts                 # buildCustomTools() factory
│   │   ├── get-balances.ts          # Read collateral balances
│   │   ├── get-chain-metadata.ts    # Chain config metadata
│   │   ├── check-hyperlane-delivery.ts  # Mailbox.delivered() check
│   │   └── save-context.ts          # Persist LLM context summaries
│   └── sim/
│       └── LLMRebalancerRunner.ts   # IRebalancerRunner for rebalancer-sim
└── scripts/
    └── run.ts                       # Production entry point
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

Skills are `SKILL.md` files that teach the agent execution capabilities via bash/cast. Copied to `.pi/skills/` at runtime.

| Skill               | Purpose                                                 | Tools             |
| ------------------- | ------------------------------------------------------- | ----------------- |
| `execute-rebalance` | Call `rebalance(uint32,uint256,address)` on warp tokens | bash, read, write |
| `inventory-deposit` | Approve + `transferRemote` from deficit chain           | bash, read, write |
| `bridge-tokens`     | MockValueTransferBridge (sim) or LiFi API (prod)        | bash, read, write |

## Rebalancer-Sim Integration

`LLMRebalancerRunner` implements `IRebalancerRunner`:

1. **initialize()**: Creates temp work dir, copies skills, writes `rebalancer-config.json`, builds custom tools with ethers closures
2. **start()**: Begins adaptive polling loop calling `runRebalancerCycle()` per interval
3. **stop()**: Clears timer, awaits in-flight cycle, cleans up temp dir

Extended timeouts are applied when `REBALANCERS=llm`:

- `deliveryTimeoutMs: 300_000` (5 min, vs default 60s)
- `idleTimeoutMs: 180_000` (3 min, vs default 5s)
- Mocha timeout: 600s

### Running in sim

```bash
# Requires ANTHROPIC_API_KEY or ANTHROPIC_TEST_API_KEY in environment
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "extreme-drain"

# Compare against coded rebalancers
REBALANCERS=simple,production,llm pnpm -C typescript/rebalancer-sim test --grep "extreme-drain"
```

## Production Usage

```bash
REBALANCER_KEY=0x... ANTHROPIC_API_KEY=sk-... tsx typescript/llm-rebalancer/scripts/run.ts config.json
```

Config file format:

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
  "model": "claude-sonnet-4-5"
}
```

Note: `REBALANCER_KEY` is passed via env var, not in the config file.
