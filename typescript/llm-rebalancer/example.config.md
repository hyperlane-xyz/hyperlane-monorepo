---
warpRouteIds:
  - MULTI/stableswap
registryUri: ~/devstuff/hyperlane-registry
llmProvider: codex
llmModel: gpt-5
intervalMs: 30000
db:
  url: sqlite:///tmp/llm-rebalancer.db
inflightMode: hybrid
skills:
  profile:
    observe: ./skills/observe/SKILL.md
    inflightRpc: ./skills/inflight-rpc/SKILL.md
    inflightExplorer: ./skills/inflight-explorer/SKILL.md
    inflightHybrid: ./skills/inflight-hybrid/SKILL.md
    executeMovable: ./skills/execute-movable/SKILL.md
    executeInventoryLifi: ./skills/execute-inventory-lifi/SKILL.md
    reconcile: ./skills/reconcile/SKILL.md
    globalNetting: ./skills/global-netting/SKILL.md
signerEnv: HYP_REBALANCER_KEY
inventorySignerEnv: HYP_INVENTORY_KEY
executionPaths:
  - movableCollateral
  - inventory
inventoryBridge: lifi
runtime:
  type: pi-openclaw
  command: openclaw
  argsTemplate:
    - skills
    - run
    - --skill
    - '{skillPath}'
    - --input
    - '{inputPath}'
    - --output
    - '{outputPath}'
  timeoutMs: 120000
---

# Targets
Monitor route deficits and maximize completion rate.

# RebalancingPaths
Use movable collateral where configured and inventory + lifi where needed.

# InFlightPolicy
Use hybrid source.

# RecoveryPolicy
Always resume from SQL state.
