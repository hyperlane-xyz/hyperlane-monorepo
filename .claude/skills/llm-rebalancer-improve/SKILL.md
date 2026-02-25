---
name: llm-rebalancer-improve
description: Iterative improvement loop for the LLM rebalancer. Runs simulation scenarios, analyzes failures from tool call logs, makes targeted fixes to tools/prompts, and re-verifies. Use when improving LLM rebalancer reliability or testing after changes.
---

# LLM Rebalancer Improvement Loop

Run scenarios, analyze LLM decision-making in failures, reason about fixes, verify. Repeat.

## When to Use

- After changing LLM rebalancer tools, prompts, or models
- When a scenario is failing and you need to diagnose why
- Periodic reliability check
- User asks to "improve the rebalancer" or "run the improvement loop"

## Model

Use `gpt-5.1-codex-mini` via opencode provider for cost reasons. Set `OPENCODE_API_KEY` env var.

## Key Files

| File                                                           | Purpose                                            |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `typescript/llm-rebalancer/src/agent.ts`                       | Agent session, cycle prompt, guardrails            |
| `typescript/llm-rebalancer/src/prompt-builder.ts`              | AGENTS.md system prompt generation                 |
| `typescript/llm-rebalancer/src/tools/*.ts`                     | Tool definitions                                   |
| `typescript/llm-rebalancer/src/tools/index.ts`                 | Tool factory — wires dependencies                  |
| `typescript/llm-rebalancer/scripts/run.ts`                     | Production entry point                             |
| `typescript/llm-rebalancer/skills/`                            | Production skills (bash/cast instructions)         |
| `typescript/llm-rebalancer/configs/`                           | Production config files                            |
| `typescript/rebalancer-sim/src/runners/LLMRebalancerRunner.ts` | Sim runner, strategy + custom tools                |
| `typescript/rebalancer-sim/src/runners/rebalancing-tools.ts`   | Sim-only tools (rebalance, supply, mock_lifi_swap) |
| `typescript/rebalancer-sim/scenarios/*.json`                   | Scenario definitions                               |

## Workflow

There are two modes: **simulation** (local anvil chains, programmatic tools) and **mainnet** (real chains, skill-based bash/cast execution). Run both.

### Mode A: Simulation

#### Step 1: Build and Run

```bash
pnpm -C typescript/llm-rebalancer build && pnpm -C typescript/rebalancer-sim build
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "<pattern>" 2>&1 | tee /tmp/llm-rebalancer-run.log
```

If all scenarios pass at 100%, skip to Step 4 (Verify).

### Mode B: Mainnet

#### Step 1: Run Against Live Deployment

```bash
cd typescript/llm-rebalancer
REBALANCER_KEY=$(cat ~/devstuff/hyperlane-monorepo4/pkey.txt) \
  OPENCODE_API_KEY=$OPENCODE_API_KEY \
  npx tsx scripts/run.ts configs/multi-stableswap-arb-base.json 2>&1 | tee /tmp/llm-rebalancer-mainnet.log
```

Let it run for 2-3 cycles, then Ctrl-C and analyze the log.
To trigger imbalance: use the CLI `hyperlane warp send` with the MULTI stableswap config.
Explorer URL: `https://explorer4.hasura.app/v1/graphql` (NOT explorer.hyperlane.xyz).

### Step 2: Analyze Failures

For each failing scenario, extract the tool call sequence:

```bash
python3 -c "
import json
for line in open('/tmp/llm-rebalancer-run.log'):
    line = line.strip()
    if not line.startswith('{'): continue
    try:
        obj = json.loads(line)
        if obj.get('tool'):
            print(f\"{obj['tool']:30s} {obj.get('msg',''):15s} {json.dumps(obj.get('args',{}))}\")
    except: pass
"
```

Read the scenario JSON to understand what the LLM was supposed to accomplish. Then trace through the tool call log and reason about:

- What did the LLM see? (tool responses)
- What did the LLM decide to do? (tool calls)
- Where did its reasoning go wrong?
- What information was it missing, or what feedback was misleading?

Read the relevant source files (tools, prompts, runner) before proposing any changes.

### Step 3: Fix and Re-run

Make targeted changes based on your analysis. Rebuild and re-run the failing scenario:

```bash
pnpm -C typescript/llm-rebalancer build && pnpm -C typescript/rebalancer-sim build
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "<failing-scenario>" 2>&1 | tee /tmp/llm-rebalancer-fix.log
```

If still failing, go back to Step 2. If passing, continue.

### Step 4: Verify

Run ALL scenarios at least 3 times to confirm reliability (LLM behavior is non-deterministic):

```bash
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "<pattern>" 2>&1 | tee /tmp/llm-rebalancer-verify1.log
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "<pattern>" 2>&1 | tee /tmp/llm-rebalancer-verify2.log
REBALANCERS=llm pnpm -C typescript/rebalancer-sim test --grep "<pattern>" 2>&1 | tee /tmp/llm-rebalancer-verify3.log
```

3 consecutive clean runs = reliable. Report results + any fixes made.

## Overfitting Guard

**Every proposed fix must pass this test: "Would this improve behavior across ALL scenarios and ANY reasonable LLM model, not just the one that failed?"**

Signs you are overfitting:

- Fix references a specific scenario name or transfer pattern
- Fix only helps when the LLM makes one particular wrong choice
- Fix adds a special case / if-branch for a narrow condition
- You find yourself tuning magic numbers or thresholds

Good fixes are structural — they change what information the LLM sees or how tools validate inputs/outputs. They make it harder for ANY model to make the wrong decision, rather than nudging one model toward the right one.
