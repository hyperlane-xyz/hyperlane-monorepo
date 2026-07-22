---
name: fetch-linear-ticket
description: Fetch a Linear ticket's title + description (the source of all warp route parameters) from a ticket ID or URL, using whichever Linear access the agent has — a Linear integration/tool if present, otherwise the Linear GraphQL API with LINEAR_API_KEY — and halt clearly if no access is configured. Referenced by every warp deploy/update skill that reads a ticket.
---

# Fetch Linear Ticket

Every warp deploy/update skill starts from a Linear ticket whose description carries the route parameters (token, chains, fee type, owners, etc.). This skill standardizes how the ticket is fetched so the access method and the not-configured error are consistent across the chain, rather than each skill hard-coding one path.

## Input

- **Ticket ID or URL** (required) — e.g. `ENG-3516` or `https://linear.app/hyperlane-xyz/issue/ENG-3516/...`.

## Step 1: Extract the issue ID

From a URL, pull the issue key (e.g. `ENG-3516`). If given a bare key, use it directly.

## Step 2: Fetch the ticket (capability-first)

Fetch the issue's **title** and **description** using whichever Linear access this agent has:

- **Preferred — the agent's Linear integration.** If a Linear tool/integration is available (e.g. a `get_issue` capability), use it to fetch the issue by key. This path also exposes attachment/image signed URLs (used later for logos).
- **Fallback — the GraphQL API.** If no integration is available but `LINEAR_API_KEY` is set, query the API directly:

  ```bash
  curl -s -X POST https://api.linear.app/graphql \
    -H "Authorization: $LINEAR_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"query": "{ issue(id: \"<ISSUE_ID>\") { title description } }"}'
  ```

**If neither is available** — no Linear integration AND `LINEAR_API_KEY` unset or returning 401 — halt and tell the user:

> No Linear access is configured. Either enable the Linear integration, or `export LINEAR_API_KEY=<your-key>` and restart Claude Code, then try again.

## Step 3: Return

Show the user the ticket **title** and **description** before proceeding. The calling skill parses the description for its own fields (token details, chains, fee type, warp route ID, owners, quote signers, ownership table, change instructions, etc.) — this skill only fetches; it does not interpret.

## Consumers

`/warp-deploy-fund-deployer`, `/warp-deploy-init-route`, `/warp-deploy-validate-owners`, `/warp-deploy-update-owners`, `/warp-update`, `/warp-update-extend`. (Fetching a fresh signed URL for a logo attachment mid-skill is a separate, integration-specific operation and stays in the caller.)
