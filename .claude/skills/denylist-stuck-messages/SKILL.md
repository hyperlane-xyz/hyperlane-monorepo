---
name: denylist-stuck-messages
description: Denylist stuck messages that are causing relayer queue alerts. Use when alerts mention "queue length > 0", when messages are stuck in the prepare queue, or when asked to blacklist/denylist specific messages for an app context.
---

# Denylist Stuck Messages

Add stuck messages to the relayer denylist to stop retrying undeliverable messages.

## When to Use

1. **Alert-based triggers:**

   - Alert: "Known app context relayer queue length > 0 for 40m"
   - Any alert mentioning stuck messages in prepare queue
   - High retry counts for specific app contexts

2. **User request triggers:**
   - "Denylist messages for [app_context]"
   - "Blacklist stuck messages on [chain]"
   - "Stop retrying messages for [warp_route]"
   - Pasting a Grafana alert URL like `https://abacusworks.grafana.net/alerting/grafana/.../view`

## Input Parameters

The skill accepts either:

**Option 1: Grafana Alert URL (recommended)**

```
/denylist-stuck-messages https://abacusworks.grafana.net/alerting/grafana/cdg1ro5hi4vswb/view?tab=instances
```

The skill will fetch the alert, extract all firing instances, and get `app_context` and `remote` labels automatically.

**Option 2: Manual specification**

```
/denylist-stuck-messages app_context=EZETH/renzo-prod remote=linea
```

| Parameter     | Required | Default    | Description                                                           |
| ------------- | -------- | ---------- | --------------------------------------------------------------------- |
| `alert_url`   | No       | -          | Grafana alert URL (extracts app_context/remote from firing instances) |
| `app_context` | No\*     | -          | The app context (e.g., `EZETH/renzo-prod`, `oUSDT/production`)        |
| `remote`      | No\*     | -          | Destination chain name (e.g., `linea`, `ethereum`, `arbitrum`)        |
| `environment` | No       | `mainnet3` | Deployment environment                                                |

\*Either `alert_url` OR both `app_context` and `remote` must be provided.

## Chain Name to Domain ID Mapping

Look up domain IDs in `rust/main/app-contexts/mainnet_config.json`. The app context's `matchingList` contains `originDomain` and `destinationDomain` fields with the numeric IDs.

## Workflow

### Step 0: Parse Input and Extract Alert Instances

**If Grafana alert URL provided:**

1. Extract the alert UID from the URL (e.g., `cdg1ro5hi4vswb` from `.../alerting/grafana/cdg1ro5hi4vswb/view`)

2. Use the Grafana MCP tool to get alert details:

   ```
   mcp__grafana__get_alert_rule_by_uid(uid="cdg1ro5hi4vswb")
   ```

3. Use the Grafana MCP tool to get firing instances:

   ```
   mcp__grafana__list_alert_groups()
   ```

   Filter for alerts matching the rule UID and state "alerting" or "firing".

4. Extract `app_context` and `remote` labels from each firing instance. These are in the alert labels:

   - `app_context`: e.g., `EZETH/renzo-prod`
   - `remote`: e.g., `linea`

5. Collect all unique `(app_context, remote)` pairs from firing instances.

**If manual app_context/remote provided:**

Use the provided values directly. Multiple pairs can be comma-separated:

```
app_context=EZETH/renzo-prod,oUSDT/production remote=linea,celo
```

### Step 1: Setup Port-Forward to Relayer

First, check if port 9090 is already in use:

```bash
lsof -i :9090
```

If not in use, start port-forward in background:

```bash
kubectl port-forward omniscient-relayer-hyperlane-agent-relayer-0 9090 -n mainnet3 &
```

Wait a few seconds for the port-forward to establish.

### Step 2: Query Relayer API for Stuck Messages

For each `remote` chain, convert to domain ID and query:

```bash
curl -s 'http://localhost:9090/list_operations?destination_domain=<DOMAIN_ID>' | jq '.'
```

The response contains operations with:

- `id`: Message ID (H256)
- `operation.sender_address`: Sender address
- `operation.recipient_address`: Recipient address
- `operation.retry_count`: Number of retries (higher = more stuck)
- `operation.origin_domain_id`: Origin chain domain
- `operation.destination_domain_id`: Destination chain domain

### Step 3: Filter Messages by App Context

Look up the `app_context` in `rust/main/app-contexts/mainnet_config.json` to get the matching sender/recipient addresses:

```bash
jq '.metricAppContexts[] | select(.name == "<APP_CONTEXT>")' rust/main/app-contexts/mainnet_config.json
```

This returns the `matchingList` with `originDomain`, `senderAddress`, `destinationDomain`, `recipientAddress` for the app context.

Filter the API results to only include messages where:

- `sender_address` matches one of the `senderAddress` values (case-insensitive, both are 0x-prefixed H256)
- `recipient_address` matches one of the `recipientAddress` values

**Important**: Addresses in the config are padded to 32 bytes (H256 format). The API returns the same format.

### Step 4: Present Messages for User Confirmation

Use `AskUserQuestion` to confirm which messages to denylist:

Present a summary table:

```
Found X messages for app_context=[APP_CONTEXT] to [REMOTE]:

| Message ID | Retry Count | Origin | Destination |
|------------|-------------|--------|-------------|
| 0xabc...   | 45          | arbitrum | linea |
| 0xdef...   | 52          | arbitrum | linea |
```

Ask: "Which messages should be added to the denylist?"

Options:

1. "All X messages" (Recommended) - Add all found messages
2. "Let me specify" - User will provide specific message IDs
3. "None - cancel" - Abort the operation

If user selects "Let me specify", ask for the specific message IDs.

### Step 5: Update Blacklist Configuration

Edit `typescript/infra/config/environments/mainnet3/customBlacklist.ts`:

1. Read the current file
2. Add new message IDs to the `blacklistedMessageIds` array
3. Include a comment with:
   - App context name
   - Date (YYYY-MM-DD format)
   - Brief reason (e.g., "stuck in prepare queue")

Example addition:

```typescript
  // [APP_CONTEXT] stuck messages [YYYY-MM-DD]
  '0xabc123...',
  '0xdef456...',
```

Add the new entries near the end of the array, before the closing bracket, grouped by app context.

### Step 6: Create Branch and Pull Request

```bash
# Create branch
git checkout -b denylist/<app_context>-<date>

# Stage changes
git add typescript/infra/config/environments/mainnet3/customBlacklist.ts

# Commit
git commit -m "denylist: add stuck messages for <APP_CONTEXT>

Added X message IDs to denylist for <APP_CONTEXT> route.
Messages were stuck in prepare queue with high retry counts.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"

# Push and create PR
git push -u origin HEAD
gh pr create --title "chore: denylist <APP_CONTEXT> stuck messages" --body "$(cat <<'EOF'
## Summary
- Added X message IDs to the relayer denylist
- App context: `<APP_CONTEXT>`
- Destination: `<REMOTE>`
- Reason: Messages stuck in prepare queue with high retry counts

## Message IDs
<list of message IDs>

## Test plan
- [ ] Review message IDs are correct
- [ ] Relayer already deployed with these changes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Step 7: Ask User to Confirm Deployment

After creating the PR, ask the user if they want to deploy the relayer now:

Use `AskUserQuestion`:

- Question: "PR created. Deploy the relayer now with the updated denylist?"
- Options:
  1. "Yes, deploy now" (Recommended) - Run deployment immediately
  2. "No, I'll deploy later" - Skip deployment, output command for later use

If user confirms deployment, run:

```bash
pnpm --dir typescript/infra exec tsx ./scripts/agents/deploy-agents.ts -e mainnet3 --context hyperlane --role relayer
```

If user skips deployment, output the command for them to run later.

### Step 8: Output Slack Message

After deployment, output Slack message for awareness:

**Slack Message (copy/paste to #relayer-alerts or relevant channel):**

```
🚫 *Denylist deployed*

App context: `<APP_CONTEXT>`
Destination: `<REMOTE>`
Messages denylisted: X

PR: <PR_URL>
```

## Handling Multiple App Contexts

If the alert has multiple firing instances (multiple app_context/remote pairs):

1. Process each pair sequentially
2. Collect all message IDs across all pairs
3. Present a combined summary for user confirmation
4. Create a single PR with all changes
5. Group message IDs by app context in the blacklist file with separate comments

## Error Handling

- **No firing alert instances**: Inform user the alert may have resolved; no action needed
- **Port-forward fails**: Ask user to check kubectl context and cluster access
- **No messages found**: Inform user the queue may have cleared; no action needed
- **API returns error**: Check if relayer pod is running with `kubectl get pods -n mainnet3`
- **App context not found in config**: The app context may be new or custom; ask user to provide sender/recipient addresses manually
- **Cannot parse alert URL**: Ask user to provide app_context and remote manually

## Prerequisites

- `kubectl` configured with access to mainnet cluster
- `gh` CLI authenticated
- Git configured with push access to the repo
