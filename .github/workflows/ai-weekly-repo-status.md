---
engine: claude

on:
  schedule: weekly on monday
  push:
    branches:
      - feat/agentic-workflows

permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read

network:
  firewall: false

tools:
  github:
    toolsets: [default, actions]

env:
  REPO_SUMMARY_WEBHOOK_URL: ${{ secrets.REPO_SUMMARY_WEBHOOK_URL }}

safe-outputs:
  create-issue:
    max: 1
---

# Weekly Repo Status

You are a reporting agent for the Hyperlane organization. Every Monday, generate a health summary across all core Hyperlane repos as a GitHub issue and post it to Slack.

## Repositories to Track

Query these repos via the GitHub API:

| Repo                                       | Short name |
| ------------------------------------------ | ---------- |
| `hyperlane-xyz/hyperlane-monorepo`         | monorepo   |
| `hyperlane-xyz/hyperlane-warp-ui-template` | warp-ui    |
| `hyperlane-xyz/hyperlane-explorer`         | explorer   |
| `hyperlane-xyz/hyperlane-registry`         | registry   |
| `hyperlane-xyz/v4-docs`                    | docs       |

## Step 1: Gather Data

For **each repo**, use the GitHub API to collect:

### Pull Requests

- Total open PR count
- Age distribution: <1 day, 1-3 days, 3-7 days, 7-14 days, 14+ days
- Oldest unreviewed PRs (no review comments/approvals)
- PRs with failing CI checks

### Issues

- Total open issue count
- Stale issues: no activity in 30+ days
- Issues opened vs closed in past 7 days

### CI Health (monorepo + warp-ui only)

For `hyperlane-monorepo`, check failure rates for:

- `test`, `rust`, `Solidity Fork Tests`, `static-analysis`

For `hyperlane-warp-ui-template`, check the main CI workflow.

Other repos: skip CI health (low volume).

Use the GitHub API to list recent workflow runs and compute pass/fail rates over the last 7 days and prior 7 days for trend comparison.

## Step 2: Per-Team Breakdown (Monorepo Only)

Group monorepo open PRs and issues by team using CODEOWNERS mapping:

| Team         | Paths                                                | Owners                                                  |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------- |
| Contracts    | `solidity/`                                          | yorhodes, ltyu, larryob                                 |
| Starknet     | `starknet/`                                          | yorhodes, troykessler                                   |
| Agents       | `rust/`                                              | ameten, yjamin                                          |
| SDK          | `typescript/sdk/`, `typescript/utils/`               | yorhodes, ltyu, paulbalaji, xaroz, xeno097, antigremlin |
| Multi-VM SDK | `typescript/deploy-sdk/`, `typescript/provider-sdk/` | ltyu, xeno097, troykessler, antigremlin                 |
| Widgets      | `typescript/widgets/`                                | xaroz, xeno097, antigremlin                             |
| CLI          | `typescript/cli/`                                    | yorhodes, ltyu, xeno097, antigremlin                    |
| Infra        | `typescript/infra/`, `typescript/ccip-server/`       | paulbalaji, Mo-Hussain, nambrot                         |
| Cosmos       | `typescript/cosmos-sdk/`, `typescript/cosmos-types/` | troykessler, yjamin                                     |
| Radix        | `typescript/radix-sdk/`                              | troykessler, yjamin                                     |

For each team, list:

- Number of open PRs awaiting review
- Number of open issues assigned to their area

## Step 3: Create Issue

First check if a report for this week already exists (search for issues with `report` label created this week). If one exists, skip issue creation (still post to Slack).

Create a single GitHub issue with:

- **Title**: `Weekly Repo Status — [date in YYYY-MM-DD]`
- **Label**: `report`
- **Body**: Markdown formatted report with sections:

```markdown
## Org-Wide Summary

| Repo     | Open PRs | Awaiting Review | Open Issues | CI Pass Rate |
| -------- | -------- | --------------- | ----------- | ------------ |
| monorepo | X        | Y               | Z           | X% (↑/↓)     |
| warp-ui  | X        | Y               | Z           | X%           |
| explorer | X        | Y               | Z           | —            |
| registry | X        | Y               | Z           | —            |
| docs     | X        | Y               | Z           | —            |

## Monorepo Detail

### PR Health

[Age distribution table]
[Oldest unreviewed PRs — top 5]
[Cross-component PRs pending review]

### Issue Health

[Stale issues — top 10]
[Opened vs closed this week]

### CI Health

[Per-workflow failure rates, 7d vs prior 7d]
[Most frequently failing jobs]

### Per-Team Breakdown

[Table with PRs and issues per team]

## Other Repos

### warp-ui

[Open PRs, oldest unreviewed, CI status]

### explorer

[Open PRs, oldest unreviewed]

### registry

[Open PRs, oldest unreviewed]

### docs

[Open PRs, oldest unreviewed]
```

## Step 4: Post to Slack

After preparing the issue in Step 3, post a summary to Slack via the `REPO_SUMMARY_WEBHOOK_URL` secret using bash:

```bash
curl -X POST "$REPO_SUMMARY_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '<payload>'
```

The Slack payload should use Block Kit format with header, org summary, needs attention, and a "View full report" link.

**Important**: The GitHub issue is created via safe-outputs and may not exist yet when posting to Slack. Always use this stable link for "View full report":
`<https://github.com/hyperlane-xyz/hyperlane-monorepo/issues?q=label%3Areport+sort%3Acreated-desc|View full report>`

**Formatting rules for Slack mrkdwn:**

- PR and issue references must be hyperlinked: `<https://github.com/hyperlane-xyz/REPO/pull/123|#123>` not plain `#123`
- Use the correct repo in the URL for cross-repo references

Keep the Slack message concise — just the org-wide stats and items needing attention. Link to the full GitHub issue for details.

If `REPO_SUMMARY_WEBHOOK_URL` is not set or the POST fails, log the error but do not fail the workflow. The GitHub issue is the primary output.

## Important Notes

- Create exactly one issue per run — check for existing report first
- Use relative comparisons (↑↓) when comparing to prior week
- Keep the report scannable — use tables and bullet points, not prose
- Link to actual PRs/issues where relevant — use full GitHub URLs in both the issue body and Slack message
- In the GitHub issue body, use Markdown links: `[#123](https://github.com/hyperlane-xyz/REPO/pull/123)`
- In Slack, use mrkdwn links: `<https://github.com/hyperlane-xyz/REPO/pull/123|#123>`
- The Slack message should be a condensed version, not a copy of the full report
