---
name: denylist-stuck-messages
description:
  Add message IDs to the registry's environment-specific relayer runtime denylist after
  investigating stuck messages. Updates apply after merge without a redeploy.
---

# Denylist Stuck Messages

Relayers in `hyperlane`, `rc`, and `fastpath` poll their environment's registry
feed every minute: `deployments/relayer/mainnet-denylist.json` for `mainnet3`,
or `deployments/relayer/testnet-denylist.json` for `testnet4`. Confirm the
environment from the investigation or user instruction before editing. Change
the appropriate file in `/Users/pbio/work/hyperlane-registry`; do not add a
static monorepo blacklist or bump `.registryrc` for a runtime rule change.

## Input

- Message IDs: `0x` followed by exactly 64 hexadecimal characters.
- App context and reason: use the investigation results or the user's explanation.
- `addedBy`: the author, normally their GitHub handle.
- `expiresAt`: optional RFC 3339 expiry, only when requested.

Example:

```text
/denylist-stuck-messages <message_ids> app_context=USDC/mainnet-cctp-v2-standard reason=<reason>
```

## Workflow

### 1. Verify the targets

Parse space-, newline-, or comma-separated message IDs. Validate every ID and
remove duplicates. Show the app context, reason, and exact IDs before making
changes. Ask for confirmation when the intended targets are unclear; an explicit
instruction to denylist the supplied IDs already authorizes the edit.

### 2. Prepare the registry checkout

Use `/Users/pbio/work/hyperlane-registry`, or the registry checkout explicitly
specified by the user. Inspect status and preserve existing work. Start a fresh
branch from current `main`, such as `<handle>/denylist-<app-context-slug>`.

Read `deployments/relayer/README.md` and the selected environment's JSON file. Check whether each
message is already denied before adding anything. Preserve existing rules and
their attribution.

### 3. Add rules

Append one rule per new message ID to the existing `rules` array:

```json
{
  "reason": "<APP_CONTEXT>: <REASON> [YYYY-MM-DD]",
  "addedBy": "<github_handle>",
  "match": {
    "messageId": "<0x followed by 64 hex characters>"
  }
}
```

JSON does not support comments. Include destination/grouping context in `reason`.
When the user supplies an expiry, add `expiresAt` to each applicable rule and
validate it as an RFC 3339 timestamp before opening the PR. Omit it when no expiry
was requested.
For other rule types, follow the registry README: exactly one of `match` or
`address`; a `match` needs at least one non-wildcard exact-match field.
`bodyRegex` alone does not qualify. Never add a broad rule just to avoid listing
specific message IDs.
The seven migrated exploit addresses also have a scoped body-regex rule in
each feed. Remove an address from both representations together; an `address`
rule alone does not scan nested calldata.

### 4. Validate and open a registry PR

Use the registry's pinned Node version, format the JSON, and run its unit tests:

```bash
cd /Users/pbio/work/hyperlane-registry
nvm use
pnpm exec oxfmt --check deployments/relayer/*-denylist.json
pnpm run test:unit
```

Follow registry changeset conventions; write any required changeset directly
rather than running the interactive changeset CLI. Commit with hooks enabled,
push, and open a PR in `hyperlane-xyz/hyperlane-registry`.

Use Problem / Solution / Validation in the PR description. Include the exact
message IDs, reason, app context, and test result. Use a body file or structured
API argument to preserve the Markdown. Report the PR URL. Merge only when the
user has authorized it.

### 5. Verify activation after merge

A rule edit needs no relayer deployment once runtime denylisting is enabled.
`raw.githubusercontent.com` caches responses for up to five minutes, followed by
the relayer's one-minute poll, so allow about six minutes after merge.

Read back the merged file and check the relayers' loaded rule counts and denial
logs in all three contexts. For an urgent refresh, the configured relayer's
`POST /runtime_denylist/refresh` endpoint fetches immediately, but can still read a
cached GitHub response. Do not claim activation from merge or endpoint success
alone; verify the rule was loaded and the target messages are denied.

A failed refresh logs an error and retains the last good rules. On startup, a
failed fetch uses the disk cache; without a valid cache the relayer starts with
no runtime rules and logs an error. Surface a load failure and investigate it.
This startup behavior is an accepted launch tradeoff from #9945. Recover by
restoring the feed and triggering a refresh; if GitHub is unavailable, point
the configured URL at another copy of the list. The refresh API only re-reads
that URL; it does not accept rule uploads.

If runtime denylisting has not yet been deployed, report that prerequisite and
prepare the three-context relayer rollout separately. Adding a registry rule
does not upgrade an older agent.

## Handoff

Report the registry PR, number of new rules, reason, validation, and whether
activation was verified or remains pending. If useful, provide a Slack message
for the user to copy; do not send it unless explicitly authorized.
