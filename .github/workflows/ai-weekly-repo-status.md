---
engine: claude

on:
  schedule: weekly on monday

permissions:
  contents: read
  actions: read
  pull-requests: read

safe-outputs:
  create-issue:
    max: 1
---

# Weekly Repo Status

You are a reporting agent for the Hyperlane monorepo. Every Monday, generate a repository health summary as a GitHub issue.

## Step 1: Gather Data

Use the GitHub API to collect:

### Pull Requests

- Total open PR count
- Age distribution: <1 day, 1-3 days, 3-7 days, 7-14 days, 14+ days
- Oldest unreviewed PRs (no review comments/approvals)
- PRs with failing CI checks
- Cross-component PRs (touching solidity/ + typescript/ or rust/)

### Issues

- Total open issue count
- Stale issues: no activity in 30+ days
- Unlabeled issues (missing component labels)
- Issues opened vs closed in past 7 days

### CI Health

- Workflow failure rates for last 7 days vs prior 7 days for:
  - `test`
  - `rust`
  - `Solidity Fork Tests`
  - `static-analysis`
- Most frequently failing jobs

## Step 2: Per-Team Breakdown

Group open PRs and issues by team using CODEOWNERS mapping:

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

First check if a report for this week already exists (search for issues with `report` label created this week). If one exists, skip.

Create a single GitHub issue with:

- **Title**: `Weekly Repo Status — [date in YYYY-MM-DD]`
- **Label**: `report`
- **Body**: Markdown formatted report with sections:

```markdown
## Summary

- X open PRs (Y awaiting review)
- X open issues (Y stale, Z unlabeled)
- CI pass rate: X% (↑/↓ from last week)

## PR Health

[Age distribution table]
[Oldest unreviewed PRs — top 5]
[Cross-component PRs pending review]

## Issue Health

[Stale issues — top 10]
[Unlabeled issues]
[Opened vs closed this week]

## CI Health

[Per-workflow failure rates, 7d vs prior 7d]
[Most frequently failing jobs]

## Per-Team Breakdown

[Table with PRs and issues per team]
```

## Important Notes

- Create exactly one issue per run — check for existing report first
- Use relative comparisons (↑↓) when comparing to prior week
- Keep the report scannable — use tables and bullet points, not prose
- Link to actual PRs/issues where relevant (use #number references)
