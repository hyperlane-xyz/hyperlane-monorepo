# Hyperlane Operational Debugging with AI Agents

This guide shows how to use Claude with Grafana and GCP logging integration to debug Hyperlane operational incidents.

## Overview

Claude can automatically query Grafana alerts/dashboards and GCP logs to help diagnose common operational issues. This enables faster incident response and reduces the need for manual investigation.

**IMPORTANT DEBUGGING STRATEGY:**

1. **ALWAYS start with Grafana alerts and dashboards first** - Get immediate context about the incident
2. **Then query GCP logs for detailed analysis** - Dive into specifics only after understanding the high-level issue
3. **All Hyperlane logs are in GCP Logging**, NOT in Grafana Loki - Grafana is for metrics/alerts only

## Configuration References

For debugging warp route issues, token imbalances, or deployment problems:

**Canonical Registry**: https://github.com/hyperlane-xyz/hyperlane-registry/

- **Warp Route Configurations**: `/deployments/warp_routes/[TOKEN]/` - Contains current token addresses, standards, and cross-chain connections
- **Chain Configurations**: `/chains/` - Network settings and contract addresses
- **Always check the canonical registry first** when investigating token bridge issues or imbalances

**Common Token Investigation Patterns**:

- Check if scaling factors are correctly configured between chains
- Verify collateral vs synthetic token standards match expectations
- Confirm contract addresses match between local config and canonical registry
- Look for recent ownership changes or contract upgrades

## Incident Investigation Workflow

### Step 1: Check Grafana Alerts and Context

**Generally start your investigation here:**

1. **Query active alerts** to understand the incident:

   ```
   list_alert_rules(label_selectors=[{'filters': [{'name': 'severity', 'type': '=', 'value': 'critical'}]}])
   ```

2. **Check recent incidents** in Grafana Incident:

   ```
   list_incidents(status='active')
   ```

3. **Review relevant dashboards** based on the alert type

### Step 2: Grafana Dashboard Analysis

After identifying the alert, immediately check the corresponding dashboards for context:

### Key Dashboards for Debugging

1. **Easy Dashboard** (`uid: fdf6ada6uzvgga`)

   - **Primary panels for incidents:**
     - "Prepare queues per Hyperlane App" - Filter by `app_context` to see specific application issues
     - "Critical Reprepare Reasons" - Shows operation_status breakdown for stuck messages
     - "Prepare queue diffs" - Identifies sudden queue buildups
   - **Variables:** Set `chain` and `RelayerContext` filters to narrow down issues

2. **Relayers v2 & v3** (`uid: k4aYDtK4k`)

   - "Prepare Queues by Remote" - Overall queue health by destination chain
   - "Queue Lengths" - Detailed view with queue_name breakdown
   - "Messages Processed" - Verify if messages are flowing

3. **RPC Usage & Errors** (`uid: bdbwtrzoms5c0c`)

   - Check RPC error rates when suspecting infrastructure issues
   - Monitor specific chain RPC health

4. **Lander Dashboard** (`uid: 197feea9-f831-48ce-b936-eaaa3294a3f6`)

   - **Transaction submission metrics:**
     - "Building Queue Length" - Messages waiting to be built into transactions
     - "Inclusion Queue Length" - Transactions waiting for inclusion on-chain
     - "Finality Queue Length" - Transactions waiting for finalization
   - **Gas management:**
     - "Gas Price (Gwei)" - Current gas prices being used
     - "Priority Fee" - EIP-1559 priority fees
   - **Transaction health:**
     - "Finalized Transactions" - Successfully submitted txs
     - "Dropped Transactions" - Failed transaction submissions
     - "Avg (Re)submissions Per Tx" - Gas escalation behavior
   - **Key for debugging:** High inclusion queue length indicates transaction submission issues

5. **Validator Dashboard - In-house** (`uid: xrNCvpK4k`)

   - **Critical validator health metrics:**
     - "Unsigned Messages" - Messages observed but not yet signed by validators
     - "Messages Signed" - Rate of checkpoint signing activity
     - "Observation Lag" - Difference between validator instances
   - **Key variables:** Set `chain` parameter to filter by origin chain (e.g., `hyperevm`)

6. **Validator Dashboard - External** (`uid: cdqntgxna4vswd`)
   - **Critical validator health metrics:**
     - "Diff observed - processed checkpoints" - Unsigned messages waiting for validator signatures
     - "Signed Checkpoint Diffs (30m)" - Validator signing activity
     - "Contract Sync Liveness" - Validator chain synchronization health
   - **Key for validator issues:** Non-zero "Diff observed - processed" indicates validators not signing checkpoints

### Key Metrics for Queue Debugging

**Find stuck messages with specific error types:**

```promql
hyperlane_submitter_queue_length{
  app_context="EZETH/renzo-prod",  # Specific app
  remote="linea",                   # Destination chain
  operation_status=~"Retry\\(Error estimating costs.*\\)"
}
```

**Check prepare queue by app context:**

```promql
sum by (app_context, remote, operation_status) (
  hyperlane_submitter_queue_length{
    queue_name="prepare_queue",
    remote="linea",
    operation_status!="FirstPrepareAttempt"
  }
)
```

**Identify messages with high retry counts:**

```promql
hyperlane_operations_processed_count{
  phase="failed",
  chain="linea"
}
```

**Monitor Lander transaction submission stages:**

```promql
# Check if transactions are stuck in inclusion
hyperlane_lander_inclusion_stage_pool_length{
  destination="linea"
}

# Monitor gas price escalation
hyperlane_lander_gas_price{destination="linea"} / 1000000000

# Check transaction finalization rate
rate(hyperlane_lander_finalized_transactions[5m])
```

### Debugging Workflow with Grafana + GCP

1. **Start with Grafana metrics:**
   - Check Easy Dashboard for queue length alerts
   - Filter by `app_context` to isolate the problematic application
   - Look at `operation_status` labels to understand error type
2. **Identify error patterns:**

   - `Retry(Error estimating costs for process call)` → Gas estimation failure, check for contract reverts
   - `Retry(Could not fetch metadata)` → Usually temporary, only investigate if persistent
   - `Retry(ApplicationReport(...))` → Application-specific errors

3. **Then query GCP logs for details:**
   - Use message IDs from metrics to search logs
   - Focus on `eth_estimateGas` errors for gas estimation failures
   - Decode revert data with `cast 4byte`

## Hyperlane Explorer Integration

Use the Explorer GraphQL endpoint to identify stuck messages **before** querying GCP logs.

**Endpoint:** `https://explorer4.hasura.app/v1/graphql`

**Find unprocessed messages:**

```graphql
query GetMessages {
  message_view(
    where: {
      # Modify filters as needed:
      origin_domain: { _eq: "hyperevm" }
      destination_domain: { _eq: "ethereum" }
      is_delivered: { _eq: false } # false = undelivered
      send_occurred_at: { _gte: "2025-08-09T00:00:00Z" } # adjust time range
    }
    limit: 10
    order_by: { send_occurred_at: desc }
  ) {
    msg_id
    send_occurred_at
    delivery_occurred_at
    is_delivered
    origin_tx_hash
    destination_tx_hash
  }
}
```

**Workflow:**

1. Query Explorer for stuck messages (`is_delivered: false` with old timestamps)
2. Extract `msg_id` (convert bytea `\x05bf...` to hex `0x05bf...`)
3. Use message ID in targeted GCP log query: `[BASE_QUERY] AND "0x05bf..."`

This provides concrete message IDs for efficient log analysis instead of guessing which messages are stuck.

## Quick Diagnosis for Common Issues

### RPC Provider Errors (>10% error rate)

**Immediate action - run this query first:**

```promql
sum by (provider_node, status) (
  hyperlane_request_count{chain="[CHAIN_NAME]", method="eth_blockNumber"}
)
```

- If one provider shows failures and another shows successes → **Bad endpoint in config**
- If all providers fail → **Chain-wide issue or rate limiting**

### Stuck Messages / High Queue Length

**Check operation status breakdown:**

```promql
sum by (operation_status) (
  hyperlane_submitter_queue_length{
    queue_name="prepare_queue",
    remote="[DESTINATION_CHAIN]"
  }
)
```

- `Retry(Error estimating costs...)` → **Contract revert, check gas estimation**
- `Retry(Could not fetch metadata)` → **Validator delays, check validator dashboards**
- High retry counts (>40) → **Persistent issue needs investigation**

## Common Debugging Workflows

### 1. Investigate any incident (RPC errors, stuck messages, validator issues, etc.)

**Ask Claude:**

```
Investigate the [INCIDENT_NAME] incident
```

**What Claude will do:**

1. **Query Grafana alerts first** to understand the incident context
2. **Check relevant dashboards** based on the alert type
3. **Analyze metrics** to identify patterns and affected components
4. **Then query GCP logs** for detailed root cause analysis
5. **Provide recommendations** for resolution

### 2. Check if a message was processed

**Ask Claude:**

```
Was message ID 0x[MESSAGE_ID] processed? Check the relayer logs.
```

**What Claude will do:**

- First check Grafana dashboards for queue metrics related to the message
- Query GCP logs for the specific message ID
- Check both prepare and confirm queue logs
- Analyze the message status and retry counts
- Report if the message completed successfully or got stuck

### 3. Debug stuck messages with metadata issues

**Ask Claude:**

```
Why are messages stuck in the prepare queue? Check for CouldNotFetchMetadata errors.
```

**What Claude will do:**

- **CHECK VALIDATOR DASHBOARDS FIRST**: Query validator metrics to identify signing delays
- Review validator alert status in Grafana
- Search for messages with CouldNotFetchMetadata status in GCP logs
- Look for validator inconsistencies and lagging validators
- Identify specific validators that are behind on checkpoint signing
- Cross-reference with validator alert rules for inconsistent checkpoints

### 4. Investigate RPC provider issues

**Ask Claude:**

```
Are there RPC errors affecting [CHAIN] in the last hour?
```

**What Claude will do:**

- **First check RPC Usage & Errors dashboard** (`uid: bdbwtrzoms5c0c`) for error rates
- Review RPC-related alerts in Grafana
- Then query GCP logs for SerdeJson errors and 503 responses
- Identify which chains/domains are affected
- Show patterns in RPC failures
- Help determine if provider rotation is needed

#### Efficient RPC Debugging Workflow

**CRITICAL: For any chain with >10% RPC error rate, immediately check these in order:**

1. **Check provider-specific success rates** (finds misconfigured endpoints instantly):

```promql
sum by (provider_node, status) (
  hyperlane_request_count{chain="[CHAIN]", method="eth_blockNumber"}
)
```

If one provider shows 100% failures while another succeeds, you've found a bad endpoint.

2. **Compare request rates across chains** (identifies excessive polling):

```promql
topk(10, sum by (chain) (
  rate(hyperlane_request_count{method="eth_blockNumber"}[5m])
))
```

Chains with >8 req/s for blockNumber are likely misconfigured or hitting rate limits.

3. **Check if multiple providers are configured**:

```promql
count by (chain) (
  group by (chain, provider_node) (hyperlane_request_count{chain="[CHAIN]"})
)
```

If count > 1, there are multiple providers and likely one is failing.

4. **Only then check logs** if the above doesn't reveal the issue.

#### Common RPC Error Patterns

| Error Pattern                               | Root Cause                         | Quick Fix                         |
| ------------------------------------------- | ---------------------------------- | --------------------------------- |
| 50% error rate, two providers shown         | One provider is down/misconfigured | Check config for bad endpoint     |
| High error rate on Arbitrum/Optimism chains | Nitro chains + aggressive polling  | Check if block production stopped |
| 100% failure on one provider, 0% on another | DNS change or deprecated endpoint  | Update RPC URL in config          |
| Gradually increasing error rate             | Rate limiting kicking in           | Reduce polling frequency          |
| Sudden spike to 100% errors                 | Provider outage                    | Switch to backup provider         |

#### Request Rate Red Flags

- **>10 req/s for eth_blockNumber**: Excessive polling, likely misconfiguration
- **>5 req/s for eth_getLogs**: May hit rate limits on free tiers
- **Nitro chains with constant polling**: These produce blocks on-demand, adjust expectations

### 5. Check relayer balance issues

**Ask Claude:**

```
Is the relayer running out of funds on [CHAIN]? Check balance warnings.
```

**What Claude will do:**

- Check Grafana dashboards for balance-related metrics
- Look for balance-related logs and warnings in GCP
- Check for gas estimation errors that indicate low balances
- Identify which chains need funding
- Show recent funding operations

### 6. Monitor Lander (transaction submitter) issues

**Ask Claude:**

```
Are there any Lander errors causing transaction submission failures?
```

**What Claude will do:**

- **First check Lander Dashboard** (`uid: 197feea9-f831-48ce-b936-eaaa3294a3f6`) for queue metrics
- Review transaction submission stages and gas escalation patterns
- Query Lander-specific logs from GCP
- Identify stuck or failed transaction submissions
- Suggest whether to switch back to Classic submitter

### 7. Debug validator inconsistency and checkpoint signing issues

**Ask Claude:**

```
Are there validator inconsistencies causing metadata delays for [ORIGIN_CHAIN]?
```

**What Claude will do:**

- **First check Validator Dashboards** (`uid: xrNCvpK4k` and `uid: cdqntgxna4vswd`)
- Query validator inconsistency alerts (`uid: e26839dc-2f4c-4ff3-9e31-734dbf9cf061`)
- **Use `hyperlane_observed_validator_latest_index` metric** (relayer's view of ALL validators, including external ones)
- **Convert validator addresses to names** using multisigIsm.ts mapping
- Then query GCP logs for specific validator issues
- Identify specific validator operators that are behind on checkpoint signing
- Calculate the signing delay impact on message processing
- Correlate validator delays with relayer metadata fetch failures

**CRITICAL LESSON LEARNED:**
When debugging validator checkpoint status, **always use the relayer's perspective** with `hyperlane_observed_validator_latest_index{origin="[chain]"}` rather than internal validator metrics. This shows ALL validators (including external ones like Merkly, Imperator, etc.) and their actual checkpoint signing status as seen by message processing. Internal validator metrics only show Abacus Works validators.

**Validator Debugging Methodology:**

1. **Check alert status**: Query the "Inconsistent latest checkpoints" alert
2. **Identify lagging validators**: Compare latest checkpoint indices across validator set
3. **Measure delay impact**: Calculate how far behind the lagging validators are
4. **Cross-reference with relayer issues**: Connect validator delays to `CouldNotFetchMetadata` errors
5. **Track resolution**: Monitor when lagging validators catch up

**Alternative: Use TypeScript Infra Script for Direct Validator Status**

When Grafana metrics are incomplete or missing validator data for a chain, use the infra script:

```bash
# From typescript/infra directory
yarn tsx scripts/validators/print-latest-checkpoints.ts -e mainnet3 --chains [CHAIN_NAME]

# Example for HyperEVM:
yarn tsx scripts/validators/print-latest-checkpoints.ts -e mainnet3 --chains hyperevm
```

**This script shows:**

- All validator addresses and their aliases (Abacus Works, Merkly, Imperator, etc.)
- Latest checkpoint index each validator has signed
- Their S3 bucket URLs for checkpoint storage
- Default validator status (✅ if configured properly)

**Use this when:**

- `hyperlane_observed_validator_latest_index` returns no data for a chain
- Grafana metrics are incomplete or missing
- You need to verify specific validator S3 bucket accessibility
- Debugging new chain integrations

**Key Metrics for Validator Issues:**

```promql
# Find validators behind in checkpoint signing (relayer's view - shows ALL validators)
hyperlane_observed_validator_latest_index{
  origin="hyperevm",
  hyperlane_deployment="mainnet3",
  app_context="default_ism"
}

# Check validator signing gaps over time
max by(chain) (
  hyperlane_latest_checkpoint{
    agent="validator",
    phase="validator_observed",
    chain="hyperevm"
  }
) - max by(chain) (
  hyperlane_latest_checkpoint{
    agent="validator",
    phase="validator_processed",
    chain="hyperevm"
  }
)
```

### 8. Debug gas estimation errors and contract reverts

**Ask Claude:**

```
Why are EZETH/renzo-prod messages failing with gas estimation errors on Linea?
```

**What Claude will do:**

- **First check Easy Dashboard** (`uid: fdf6ada6uzvgga`) for queue metrics with app_context filter
- Review "Critical Reprepare Reasons" panel for error patterns
- Find stuck messages with high retry counts in GCP logs
- Look for `eth_estimateGas` errors in the logs
- Extract contract revert reasons from error data
- Use `cast 4byte` to decode revert selectors (e.g., `0x0b6842aa` = `IXERC20_NotHighEnoughLimits()`)
- Identify root causes like bridging limits, insufficient approvals, or contract state issues

**Debugging Methodology for Gas Estimation Failures:**

1. Find stuck operations: `jsonPayload.fields.num_retries>=5` + specific app context
2. Extract message IDs from stuck operations
3. **Deprioritize common transient errors**: Don't focus on isolated nonce errors, connection resets, or RPC 503s unless they're persistent over longer periods
4. Search for gas estimation: `"0x[MESSAGE_ID]" AND "eth_estimateGas"`
5. Look for revert data: `"execution reverted, data: Some(String(\"0x..."`
6. Decode with: `cast 4byte 0x[selector]`

### 9. Debug Warp Route Collateral-Synthetic Imbalances

**Ask Claude:**

```
Investigate the collateral-synthetic imbalance on [WARP_ROUTE_ID]. Check for undelivered messages causing the imbalance.
```

**What Claude will do:**

1. **Check Warp Routes dashboard first**: Query Grafana for current imbalance metrics and trends
2. **Review related alerts**: Check for any Warp Route imbalance alerts
3. **Find undelivered messages**: Search Hyperlane Explorer for `is_delivered: false` messages
4. **Query rebalancer logs in GCP**: Check why automatic rebalancing isn't working
5. **Identify large transfers**: Look for message amounts matching the imbalance size
6. **Analyze root cause**: Determine if insufficient collateral is preventing message delivery

**Key Understanding of Warp Route Architecture:**

- **Collateral chains** (Ethereum, Arbitrum, Base, etc.): Hold actual USDC/tokens as collateral
- **Synthetic chains** (Mode, etc.): Hold synthetic/wrapped versions that can be minted/burned
- **Normal balance**: Total collateral ≈ Total synthetic tokens
- **Imbalance cause**: Undelivered messages from synthetic→collateral transfers

**Debugging Methodology for Warp Route Imbalances:**

1. **Query Warp Routes dashboard**: Get current imbalance amount and trend
2. **Check rebalancer logs first**: Query GCP logs for rebalancer activity
3. **Search Explorer for undelivered messages**:
   ```graphql
   query UndeliveredMessages {
     message_view(
       where: {
         is_delivered: { _eq: false }
         send_occurred_at: { _gte: "[TIME_RANGE]" }
         # Filter by warp route contract addresses if known
       }
       order_by: { send_occurred_at: desc }
       limit: 20
     ) {
       msg_id
       sender
       recipient
       origin_domain
       destination_domain
       send_occurred_at
       message_body # Contains transfer amount
     }
   }
   ```
4. **Decode message amounts**: Check if message body contains amount matching imbalance
5. **Root cause analysis**: For synthetic→collateral transfers, insufficient collateral prevents delivery
6. **Resolution**: Either fund the destination chain or wait for organic rebalancing

**Rebalancer Log Queries:**
The rebalancer automatically attempts to fix imbalances by moving tokens between chains. Check its logs to understand why rebalancing isn't working:

```
resource.type="k8s_container"
resource.labels.project_id="abacus-labs-dev"
resource.labels.location="us-east1-c"
resource.labels.cluster_name="hyperlane-mainnet"
resource.labels.namespace_name="mainnet3"
labels."k8s-pod/app_kubernetes_io/name"="rebalancer"
timestamp>="2025-08-09T20:00:00Z"
```

**Filter by specific warp route:**

```
[REBALANCER_BASE_QUERY] AND "USDC/paradex"
```

**Common rebalancer log patterns:**

- **"Insufficient balance"**: Not enough tokens on source chain to rebalance
- **"Rebalancing [amount] from [source] to [dest]"**: Active rebalancing operation
- **"Skipping rebalance"**: Conditions not met (thresholds, limits)
- **"Failed to estimate gas"**: Transaction simulation failed
- **"Waiting for [msg_id] to be delivered"**: Rebalancer waiting for stuck message

**Critical Insight**:

- When messages transfer FROM synthetic chains TO collateral chains, the synthetic tokens are burned immediately on send
- BUT the collateral tokens are only transferred on delivery
- If insufficient collateral exists on destination chain, message stays undelivered
- This creates an imbalance: less synthetic + same collateral = excess collateral

**Common Imbalance Patterns:**

- **Positive imbalance** (collateral > synthetic): Undelivered synthetic→collateral transfers
- **Negative imbalance** (synthetic > collateral): Undelivered collateral→synthetic transfers
- **Large sudden imbalances**: Look for single large undelivered message matching the amount

**Critical Debugging Rules:**

- **Deprioritize nonce errors** - these are normal during transaction submission unless persistent over hours
- **Deprioritize connection resets** - these are normal RPC hiccups unless occurring repeatedly
- **Skip metadata errors initially** - validators need finality time
- **Prioritize gas estimation errors** - these contain the real root cause
- **Focus on high retry counts** - messages stuck for 40+ retries indicate persistent issues
- When user mentions "queue length > 0 for X minutes", immediately search for stuck messages with `num_retries>=5`

## GCP Log Queries Reference

Claude uses optimized, progressive queries to minimize tokens and maximize relevance:

### Base Agent Query Templates (with noise filtering)

**Relayer Query (Optimized with Enhanced Noise Filtering):**

```
resource.type="k8s_container"
resource.labels.project_id="abacus-labs-dev"
resource.labels.location="us-east1-c"
resource.labels.cluster_name="hyperlane-mainnet"
resource.labels.namespace_name="mainnet3"
labels."k8s-pod/app_kubernetes_io/component"="relayer"
labels."k8s-pod/app_kubernetes_io/instance"="omniscient-relayer"
labels."k8s-pod/app_kubernetes_io/name"="hyperlane-agent"
-jsonPayload.fields.message="No message found in DB for leaf index"
-jsonPayload.fields.message="Found log(s) in index range"
-jsonPayload.fields.message="Dispatching get_public_key"
NOT "Instantiated AWS signer"
-jsonPayload.fields.message="Ingesting leaf"
-jsonPayload.fields.message="Message already marked as processed in DB"
-jsonPayload.fields.message="Message destined for self, skipping"
-jsonPayload.fields.message="Message has already been delivered, marking as submitted."
-jsonPayload.fields.message="Processor working on message"
-jsonPayload.fields.message="Message destined for unknown domain, skipping"
-jsonPayload.fields.message="Popped OpQueue operations"
-jsonPayload.fields.message="Validator returned latest index"
-jsonPayload.fields.message="Found signed checkpoint"
-jsonPayload.fields.return="Ok(None)"
-jsonPayload.fields.message="Fast forwarded current sequence"
-jsonPayload.fields.message="Cursor can't make progress, sleeping"
-jsonPayload.fields.message="fallback_request"
```

**Scraper Query:**

```
resource.type="k8s_container"
resource.labels.project_id="abacus-labs-dev"
resource.labels.location="us-east1-c"
resource.labels.cluster_name="hyperlane-mainnet"
resource.labels.namespace_name="mainnet3"
labels.k8s-pod/app_kubernetes_io/component="scraper3"
labels.k8s-pod/app_kubernetes_io/instance="omniscient-scraper"
labels.k8s-pod/app_kubernetes_io/name="hyperlane-agent"
```

**Validator Query:**

```
resource.type="k8s_container"
resource.labels.project_id="abacus-labs-dev"
resource.labels.location="us-east1-c"
resource.labels.cluster_name="hyperlane-mainnet"
resource.labels.namespace_name="mainnet3"
labels.k8s-pod/app_kubernetes_io/component="validator"
labels.k8s-pod/app_kubernetes_io/name="hyperlane-agent"
```

### Progressive Query Strategy

Use this token-efficient approach for all debugging scenarios:

**1. Start specific and minimal:**

```
[BASE_QUERY] AND "0x[MESSAGE_ID]"
[BASE_QUERY] AND "EZETH/renzo-prod" AND jsonPayload.fields.num_retries>=5
[BASE_QUERY] AND severity>="WARNING" AND timestamp>="-1h"
```

_Get targeted results first - only what's directly relevant_

**2. Add error context if needed:**

```
[BASE_QUERY] AND "0x[MESSAGE_ID]" AND severity>="WARNING"
[BASE_QUERY] AND "CouldNotFetchMetadata" AND jsonPayload.spans.domain:"ethereum"
```

_Layer in additional filters to understand problems_

**3. Get full context only when necessary:**

```
[BASE_QUERY] AND "0x[MESSAGE_ID]"
```

_Remove noise filters to see complete lifecycle - use sparingly due to token costs_

**4. Extract specific fields to reduce tokens:**
When requesting logs, focus on essential fields like `jsonPayload.fields.message`, `jsonPayload.fields.error`, `jsonPayload.spans.domain` rather than full log entries.

### Targeted Query Patterns

**Message status tracking:**

```
[BASE_QUERY] AND "0x[MESSAGE_ID]" AND (
  jsonPayload.fields.message:"confirmed" OR
  jsonPayload.fields.message:"delivered" OR
  jsonPayload.spans.name:"delivered"
)
```

**Error investigation:**

```
[BASE_QUERY] AND severity>="WARNING" AND (
  jsonPayload.fields.message:"CouldNotFetchMetadata" OR
  jsonPayload.fields.message:"SerdeJson error" OR
  jsonPayload.fields.error:"503 Service Temporarily Unavailable"
)
```

**Stuck message analysis:**

```
[BASE_QUERY] AND jsonPayload.fields.num_retries>=5
```

**Chain-specific issues:**

```
[BASE_QUERY] AND jsonPayload.spans.domain:"[CHAIN]" AND severity>="WARNING"
```

**Time-bounded queries:**

```
[BASE_QUERY] AND timestamp>="2025-08-09T00:30:00Z" AND [SPECIFIC_FILTER]
```

**Lander transaction submitter:**

```
[BASE_QUERY] AND jsonPayload.target:"lander"
```

**Rebalancer logs:**

```
resource.type="k8s_container"
resource.labels.project_id="abacus-labs-dev"
resource.labels.location="us-east1-c"
resource.labels.cluster_name="hyperlane-mainnet"
resource.labels.namespace_name="mainnet3"
labels."k8s-pod/app_kubernetes_io/name"="rebalancer"
```

### Query Efficiency Tips

- **Start specific**: Always begin with the most targeted query first
- **Use time bounds**: Add timestamp filters to limit results (`timestamp>=`)
- **Filter by severity**: Use `severity>="WARNING"` when looking for problems
- **Target specific fields**: Search `jsonPayload.fields.message:"exact_text"` rather than broad searches
- **Progressive detail**: Only request full log context when basic queries indicate issues
- **Avoid noise**: The base query already filters out common noisy log patterns

## Key Log Fields

When Claude analyzes logs, it focuses on these important fields:

- **`jsonPayload.fields.message`**: Main log message content
- **`jsonPayload.spans[].domain`**: Which chain/domain the operation involves
- **`jsonPayload.fields.operations`**: Details about pending messages and status
- **`jsonPayload.fields.error`**: Specific error information
- **`jsonPayload.spans[].name`**: Operation type (e.g., "confirm_classic_task", "finality_stage")
- **`jsonPayload.fields.num_retries`**: How many times a message has been retried
- **`jsonPayload.fields.status`**: Current message processing status

## Example Analysis Requests

Here are examples of how to ask Claude to help with specific debugging scenarios:

```
"Check message 0xabc123... processing status"

"Find CouldNotFetchMetadata errors in the last 2 hours"

"Look for RPC errors affecting polygon in the last hour"

"Show messages with 5+ retries stuck in queue"

"Check validator issues preventing message confirmation"

"Find relayer balance warnings on arbitrum"

"Show Lander transaction submission errors"

"Are there 503 RPC errors in the last 30 minutes?"

"Debug EZETH/renzo-prod queue length > 0 alert on Linea"

"Why are messages stuck with gas estimation errors?"
```

## Debugging Heuristics

Based on operational patterns, Claude should follow these heuristics:

**When investigating "queue length > 0" alerts:**

1. **Start with stuck operations**: Look for high retry counts (`num_retries>=5`) in the specific app context
2. **Get message IDs**: Extract the actual message IDs from stuck operations
3. **Deprioritize transient errors**: Don't focus on isolated nonce errors, connection resets, or occasional RPC failures unless they're persistent over longer periods
4. **For CouldNotFetchMetadata errors - check validators only after 5+ minutes of delays**:
   - Query validator dashboards (`uid: xrNCvpK4k` and `uid: cdqntgxna4vswd`) with origin chain filter
   - Look for "Unsigned Messages" > 0 or "Diff observed - processed checkpoints" > 0
   - Check validator inconsistency alerts (`uid: e26839dc-2f4c-4ff3-9e31-734dbf9cf061`)
   - Identify specific lagging validators with Prometheus queries
   - **Convert validator addresses to operator names** using multisigIsm.ts for targeted outreach
5. **Go directly to gas estimation**: Search for `eth_estimateGas` errors with the stuck message IDs
6. **Decode contract errors**: Use `cast 4byte` for any revert selectors found

**For efficient analysis:**

1. **Message ID first**: Always start with the specific message causing issues
2. **Progressive detail**: Basic → error context → full logs only when needed
3. **Focus on relevant spans**: Look for spans with the target chain in `jsonPayload.spans.domain`
4. **Time bounds matter**: Use `timestamp>=` filters to limit search scope
5. **Extract key fields**: Request specific JSON fields rather than full log entries

**Common error patterns:**

- `CouldNotFetchMetadata` → Normal during initial attempts (validators need finality) - **only check validators after 5+ minutes of persistent delays**
- `eth_estimateGas` failures → **TRUE ROOT CAUSE**, look for revert data immediately
- `503 Service Temporarily Unavailable` → RPC provider issues - **deprioritize unless persistent over hours**
- `nonce too low/high` → Normal during gas escalation - **deprioritize unless persistent over hours**
- `connection reset by peer` → Normal RPC hiccups - **deprioritize unless frequent**
- High `num_retries` with same error → **FOCUS HERE** - persistent problem needing attention
- `IXERC20_NotHighEnoughLimits()` → Bridge hit daily/rate limits
- `SerdeJson error` → Usually RPC response parsing issues - **deprioritize unless persistent**

**Validator-Related Patterns:**

- **5+ minute delays with high retries** → Then check validator dashboards for checkpoint signing gaps
- **Validator inconsistency alerts** → Specific validators lagging behind in checkpoint signing
- **Metadata timeouts correlating with validator gaps** → Validator availability causing relayer delays

### Optimized Query Examples

Claude will use these efficiency patterns automatically:

**Message tracking (token-efficient):**

1. First: `"0xabc123..."` - Gets basic status
2. If issues: `"0xabc123..." AND severity>="WARNING"` - Gets error details
3. If needed: Remove noise filters for complete context

**Error investigation (targeted):**

1. `severity>="WARNING" AND timestamp>="-1h"` - Recent problems only
2. `jsonPayload.fields.message:"CouldNotFetchMetadata"` - Specific error type
3. `jsonPayload.spans.domain:"ethereum"` - Chain-specific issues

## Hyperlane Registry Integration

The [Hyperlane Registry](https://github.com/hyperlane-xyz/hyperlane-registry/) provides essential reference data for debugging operational issues. Use your local registry clone to quickly access chain information.

### Registry Usage for Debugging

**Local Registry Path**: `/Users/nambrot/devstuff/hyperlane-registry`

**Quick Chain Lookups:**

```bash
# Get contract addresses for any chain
cat /Users/nambrot/devstuff/hyperlane-registry/chains/ethereum/addresses.yaml

# Check RPC endpoints and block explorer URLs
cat /Users/nambrot/devstuff/hyperlane-registry/chains/ethereum/metadata.yaml

# Find chains by name pattern
ls /Users/nambrot/devstuff/hyperlane-registry/chains/ | grep -i arbitrum
```

**Chain Information Available:**

- **Contract addresses** (`addresses.yaml`): Mailbox, ISMs, hooks, gas oracles, validators
- **Chain metadata** (`metadata.yaml`): RPC URLs, block explorers, gas settings, reorg periods
- **Warp routes** (`warp_routes.json`): Token bridge configurations across chains

**Integration with Debugging Workflow:**

1. **Contract Address Verification**: When debugging transaction failures, verify contract addresses against registry
2. **RPC Failover**: Use backup RPC URLs from registry when primary endpoints fail
3. **Block Explorer Links**: Quickly access transaction details using explorer URLs from registry
4. **Chain Configuration**: Verify block confirmation requirements and finalization settings
5. **Warp Route Analysis**: Cross-reference token bridge deployments during imbalance debugging

**Programmatic Access:**

```typescript
import { FileSystemRegistry } from '@hyperlane-xyz/registry';

const registry = new FileSystemRegistry({
  uri: '/Users/nambrot/devstuff/hyperlane-registry',
});
const chainData = await registry.getChainMetadata('ethereum');
const addresses = await registry.getChainAddresses('ethereum');
```

**JSON Query Examples:**

```bash
# Find chain by ID
jq '.[] | select(.chainId == 42161)' /Users/nambrot/devstuff/hyperlane-registry/chains.json

# Get all mainnet chains
jq '.[] | select(.environment == "mainnet")' /Users/nambrot/devstuff/hyperlane-registry/chains.json

# Find warp routes for specific token
jq '.[] | select(.token | contains("USDC"))' /Users/nambrot/devstuff/hyperlane-registry/warp_routes.json
```

## Validator Address to Name Mapping

When debugging validator issues, use the multisig ISM configuration to convert validator addresses to human-readable names.

**Location**: `/Users/nambrot/devstuff/hyperlane-monorepo/typescript/sdk/src/consts/multisigIsm.ts`

**Validator Name Lookup:**

```bash
# Find validator name by address (case-insensitive search)
grep -i -A 1 -B 1 "0x03c842db86a6a3e524d4a6615390c1ea8e2b9541" /Users/nambrot/devstuff/hyperlane-monorepo/typescript/sdk/src/consts/multisigIsm.ts

# Get all validators for a specific chain
grep -A 20 "ethereum:" /Users/nambrot/devstuff/hyperlane-monorepo/typescript/sdk/src/consts/multisigIsm.ts
```

**Common Validator Names:**

- `0x03c842db86a6a3e524d4a6615390c1ea8e2b9541` → **Abacus Works** (Ethereum)
- `0xcf0211fafbb91fd9d06d7e306b30032dc3a1934f` → **Merkly** (Multiple chains)
- `0x4f977a59fdc2d9e39f6d780a84d5b4add1495a36` → **Mitosis** (Multiple chains)
- `0x5450447aee7b544c462c9352bef7cad049b0c2dc` → **Zee Prime** (Multiple chains)
- `0x38c7a4ca1273ead2e867d096adbcdd0e2acb21d8` → **Everstake** (Multiple chains)
- `0xb3ac35d3988bca8c2ffd195b1c6bee18536b317b` → **Staked** (Multiple chains)

**Integration with Validator Debugging:**
When investigating validator inconsistencies:

1. **Get lagging validator addresses** from Grafana metrics
2. **Look up validator names** using the multisigIsm.ts file
3. **Identify specific validator operators** for targeted communication
4. **Cross-reference with alert thresholds** to understand impact severity

**Example Usage:**

```bash
# During validator debugging - convert address to name
echo "Validator 0x36f2bd8200ede5f969d63a0a28e654392c51a193 is behind"
grep -i "0x36f2bd8200ede5f969d63a0a28e654392c51a193" /path/to/multisigIsm.ts
# Output: "alias: 'Imperator'" - so you know Imperator validator is behind
```

**Programmatic Access:**

```typescript
import { defaultMultisigConfigs } from '@hyperlane-xyz/sdk';

// Get validator info for a chain
const chainValidators = defaultMultisigConfigs.ethereum.validators;
const validatorName = chainValidators.find(
  (v) =>
    v.address.toLowerCase() === '0x03c842db86a6a3e524d4a6615390c1ea8e2b9541',
)?.alias; // Returns "Abacus Works"
```

## Integration with Existing Runbook

This AI-powered debugging complements the existing manual runbook procedures. When Claude identifies an issue, it can reference specific runbook sections for resolution steps.

**Primary Runbook Reference**: [Hyperlane Operations Runbook](https://www.notion.so/hyperlanexyz/Runbook-AI-Agent-24a6d35200d680229b38e8501164ca66) - The comprehensive manual runbook containing detailed operational procedures for deployment, debugging, and incident response.

For complex issues requiring manual intervention (like validator restarts, RPC rotations, or balance funding), Claude will identify the problem and direct you to the appropriate runbook section.

**Key Runbook Sections Referenced by AI Debugging:**

- **Agent Deployment & Redeployment**: Deploy new agent versions and restart failed pods
- **RPC URL Rotation**: Update failing RPC endpoints when provider errors are detected
- **Validator Operations**: Handle validator inconsistencies and reorg recovery procedures
- **Message Processing**: Manually process stuck messages and retry failed operations
- **Balance Management**: Fund relayer keys when balance warnings are triggered
- **Security Incident Response**: Emergency procedures for compromised systems or smart contracts
- **Lander/Transaction Submitter Operations**: Debug and configure transaction submission issues

## Benefits

- **Faster triage**: Quickly identify if an issue is RPC-related, validator-related, or balance-related
- **Pattern detection**: Spot trends across multiple chains or time periods
- **Reduced context switching**: Get answers without manually constructing GCP queries
- **Historical analysis**: Easily compare current issues to past patterns

## Next Steps

As this integration matures, we can extend Claude's capabilities to:

- Automatically cross-reference with validator status dashboards
- Correlate with blockchain network issues
- Suggest specific remediation actions
- Generate incident reports with log evidence
