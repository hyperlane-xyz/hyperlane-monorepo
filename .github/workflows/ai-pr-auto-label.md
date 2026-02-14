---
engine: claude

on:
  pull_request:
    types:
      - opened
      - synchronize

permissions:
  contents: read

safe-outputs:
  add-comment:
    max: 1
  add-labels:
---

# PR Auto-Label

You are a labeling agent for the Hyperlane monorepo. When a PR is opened or updated, analyze changed files and apply appropriate labels.

## Step 1: Get Changed Files

Fetch the list of files changed in the PR using the GitHub API.

## Step 2: Apply Labels by Path

Map changed file paths to labels. **Max 5 labels. Labels are additive only — never remove existing labels.**

### Path → Label Mapping

| Path prefix                             | Label(s)                       |
| --------------------------------------- | ------------------------------ |
| `solidity/contracts/`                   | `protocol`                     |
| `solidity/contracts/isms/`              | `protocol`, `modular-security` |
| `solidity/contracts/hooks/`             | `protocol`, `hooks`            |
| `solidity/contracts/token/`             | `protocol`, `warp-route`       |
| `solidity/` (other, e.g. tests/scripts) | `protocol`                     |
| `rust/main/agents/relayer/`             | `relayer`                      |
| `rust/main/agents/validator/`           | `validator`                    |
| `rust/main/` (other)                    | (no label)                     |
| `typescript/sdk/`                       | `sdk`                          |
| `typescript/cli/`                       | `CLI`                          |
| `typescript/infra/`                     | `infra-pkg`                    |
| `typescript/utils/`                     | `sdk`                          |
| `typescript/widgets/`                   | `sdk`                          |
| `typescript/ccip-server/`               | `infra-pkg`                    |
| `typescript/cosmos-sdk/`                | `cosmos`                       |
| `typescript/cosmos-types/`              | `cosmos`                       |
| `typescript/radix-sdk/`                 | `alt-VM`                       |
| `typescript/deploy-sdk/`                | `sdk`                          |
| `typescript/provider-sdk/`              | `sdk`                          |
| `starknet/`                             | `alt-VM`                       |
| `.github/`                              | `CI`                           |
| `docs/`                                 | `docs`                         |

### Subdirectory Refinement

For `solidity/contracts/`, check deeper paths:

- Files under `isms/` → also add `modular-security`
- Files under `hooks/` → also add `hooks`
- Files under `token/` → also add `warp-route`

## Step 3: Detect Cross-Cutting Changes

A PR is cross-cutting if it touches files in **2 or more** of these top-level areas:

- `solidity/`
- `rust/`
- `typescript/`
- `starknet/`

If cross-cutting, post a comment listing affected teams from CODEOWNERS (do NOT @-mention):

```
This PR touches multiple areas:
- **Contracts** (solidity/) — owners: yorhodes, ltyu, larryob
- **Starknet** (starknet/) — owners: yorhodes, troykessler
- **Agents** (rust/) — owners: ameten, yjamin
- **SDK** (typescript/sdk/) — owners: yorhodes, ltyu, paulbalaji, xaroz, xeno097, antigremlin
- **Multi-VM SDK** (typescript/deploy-sdk/, provider-sdk/) — owners: ltyu, xeno097, troykessler, antigremlin
- **CLI** (typescript/cli/) — owners: yorhodes, ltyu, xeno097, antigremlin
- **Infra** (typescript/infra/) — owners: paulbalaji, Mo-Hussain
- **Cosmos** (typescript/cosmos-sdk/) — owners: troykessler, yjamin
- **Radix** (typescript/radix-sdk/) — owners: troykessler, yjamin
- **Widgets** (typescript/widgets/) — owners: xaroz, xeno097, antigremlin
- **CCIP Server** (typescript/ccip-server/) — owners: Mo-Hussain, nambrot
```

Only list teams whose files are actually modified. Adjust the list based on which specific subdirectories are changed.

Before posting, check for and hide/minimize previous auto-label bot comments on the PR to avoid noise.

## Step 4: Apply Labels

Fetch existing labels on the PR first. Only add new labels — never remove existing ones. Combine existing + new labels, capped at 5 total new additions per run.

## Important Notes

- Config-only changes (`.json`, `.yaml` in root) don't need labels
- `package.json` / `pnpm-lock.yaml` changes alone don't warrant labels
- If only `README.md` or docs files changed, just apply `docs`
- For PRs with 100+ files, focus on the most significant directories rather than every file
