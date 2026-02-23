# LLM-Based Warp Route Rebalancer

An LLM agent that replaces coded rebalancing strategies with prose-driven decision-making, using [Pi](https://github.com/badlogic/pi-mono) as the agent runtime.

## Architecture

**Paradigm shift**: Instead of `Monitor → Strategy → Rebalancer → ActionTracker` with hard-coded strategies (Weighted, MinAmount, CollateralDeficit), the LLM agent reads a prose strategy description (AGENTS.md), observes on-chain state via `cast`, and decides what to do.

```
┌─────────────────────────────────────────────────┐
│  Pi Agent Runtime                                │
│                                                  │
│  AGENTS.md (strategy)  +  SKILL.md files         │
│         ↓                      ↓                 │
│  ┌──────────┐  ┌─────────────────────────┐       │
│  │ Reasoning │  │ Tools: bash, read, write │      │
│  │ (LLM)    │→ │ cast, sqlite3, curl      │      │
│  └──────────┘  └─────────────────────────┘       │
│         ↓                                        │
│  ┌──────────────────────┐                        │
│  │ SQLite action log    │ (crash recovery,       │
│  │ ./action-log.db      │  inflight tracking)    │
│  └──────────────────────┘                        │
└─────────────────────────────────────────────────┘
         ↕ cast call/send
┌─────────────────────────────────────────────────┐
│  On-chain: Warp tokens, bridges, mailboxes       │
└─────────────────────────────────────────────────┘
```

### Why Pi + Skills over MCP/TypeScript

- **Zero integration code** — `cast` already speaks to any EVM chain
- **Skills are markdown** — faster to author, version-controlled, easy to evolve
- **Model-agnostic** — swap Claude for other models via config
- **Agent self-extends** — reads `--help`, inspects receipts, adapts to errors
- **Prose replaces code** — strategy is a paragraph, not a class hierarchy

### Key Design Decisions

- **Fresh session per cycle**: Each rebalancer cycle creates a new Pi session. SQLite provides continuity across cycles (inflight tracking, action history).
- **No env var mutation**: All config (keys, addresses, RPCs) is in `rebalancer-config.json`. The agent reads it via the `read` tool.
- **No MockActionTracker**: The sim's `MockInfrastructureController` auto-tracks rebalances from Dispatch events.

## Package Structure

```
typescript/llm-rebalancer/
├── package.json
├── tsconfig.json
├── skills/                          # Pi skills (version-controlled)
│   ├── check-balances/SKILL.md      # cast call to read collateral
│   ├── execute-rebalance/SKILL.md   # cast send for rebalance()
│   ├── inventory-deposit/SKILL.md   # cast send for transferRemote()
│   ├── check-inflight/SKILL.md      # query action log + on-chain state
│   ├── manage-action-log/SKILL.md   # sqlite3 CRUD
│   └── bridge-tokens/SKILL.md       # mock bridge (sim) or LiFi (prod)
├── schema/
│   └── action-log.sql               # SQLite schema
├── src/
│   ├── index.ts
│   ├── agent.ts                     # Pi session creation + cycle invocation
│   ├── config.ts                    # Config types
│   ├── prompt-builder.ts            # Generates AGENTS.md from config
│   └── sim/
│       └── LLMRebalancerRunner.ts   # IRebalancerRunner for rebalancer-sim
└── scripts/
    └── run.ts                       # Production entry point
```

## Skills

Each skill is a `SKILL.md` file that teaches the agent a capability. Skills are copied to `.pi/skills/` in the agent's working directory at runtime.

| Skill               | Purpose                                                 | Tools             |
| ------------------- | ------------------------------------------------------- | ----------------- |
| `check-balances`    | Read collateral balances via `cast call balanceOf`      | bash, read        |
| `execute-rebalance` | Call `rebalance(uint32,uint256,address)` on warp tokens | bash, read, write |
| `inventory-deposit` | Approve + `transferRemote` from deficit chain           | bash, read, write |
| `check-inflight`    | Query action log + `cast call delivered()` on mailbox   | bash, read        |
| `manage-action-log` | SQLite CRUD for crash recovery                          | bash, read        |
| `bridge-tokens`     | MockValueTransferBridge (sim) or LiFi API (prod)        | bash, read, write |

## Rebalancer-Sim Integration

`LLMRebalancerRunner` implements `IRebalancerRunner`:

1. **initialize()**: Creates temp work dir, copies skills to `.pi/skills/`, writes `rebalancer-config.json` + SQLite DB
2. **start()**: Begins polling loop calling `runRebalancerCycle()` per interval
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

### Results (extreme-drain-chain1)

| Metric        | LLMRebalancer  |
| ------------- | -------------- |
| Completion    | 100% (20/20)   |
| Rebalances    | 2 (117 tokens) |
| Avg Latency   | ~18s           |
| Test Duration | ~108s          |

## Production Usage

```bash
REBALANCER_KEY=0x... tsx typescript/llm-rebalancer/scripts/run.ts config.json
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
  "rebalancerKey": "0x...",
  "strategy": {
    "type": "prose",
    "text": "Maintain equal distribution across chains with ±15% tolerance."
  },
  "pollingIntervalMs": 30000,
  "model": "claude-sonnet-4-5"
}
```

## Open Questions

1. **Session reuse vs fresh**: Currently fresh per cycle. Could reuse for faster subsequent cycles (Pi maintains conversation context), but risks context accumulation.
2. **Model choice**: Sonnet 4.5 balances speed/cost. Haiku for cheaper runs, Opus for complex scenarios.
3. **Determinism**: LLM decisions are non-deterministic. For critical production use, consider adding typed MCP tools for more control where needed.
