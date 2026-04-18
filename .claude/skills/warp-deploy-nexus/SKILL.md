---
name: warp-deploy-nexus
description: Add a new warp route to the Nexus UI whitelist. Checks out the nexus branch of hyperlane-warp-ui-template, adds the warp route ID to warpRouteWhitelist.ts, and opens a PR targeting the nexus branch.
---

# Warp Deploy — Nexus Whitelist

You are adding a warp route to the Nexus UI whitelist.

## Input

The user provides:

- **One or more warp route IDs** (e.g. `SOL/igra`) and/or **Linear ticket URL(s)**

If Linear ticket URL(s) are provided, fetch each ticket to extract the warp route ID. If neither is provided, ask for them now.

**When multiple routes are provided**, add all of them in a single PR (Steps 3–5 cover all routes at once).

---

## Step 1: Confirm the warp route ID(s)

Show the user the warp route IDs you'll add and ask them to confirm before proceeding.

---

## Step 2: Prepare the branch

The `hyperlane-warp-ui-template` repo is at the same level as `hyperlane-monorepo`:

```
REPO_PATH="$(dirname $(pwd))/../hyperlane-warp-ui-template"
```

1. Ensure the repo is clean and up to date on the `nexus` branch:

```bash
cd "$REPO_PATH"
git fetch origin
git checkout nexus
git pull origin nexus
```

2. Create a new branch from `nexus`. For a single route use `feat/<warp-route-id-slugified>` (lowercase, `/` → `-`). For multiple routes use a descriptive slug like `feat/add-<token>-igra-routes`:

```bash
git checkout -b feat/<slug>
```

---

## Step 3: Add to whitelist

The whitelist file is at:

```
$REPO_PATH/src/consts/warpRouteWhitelist.ts
```

Read the file and add the warp route ID to the `warpRouteWhitelist` array. Insert it in alphabetical order by token symbol, then by chain string. Preserve existing formatting (single quotes, trailing comma on each entry).

Example — adding `SOL/igra` to an existing list:

```typescript
export const warpRouteWhitelist: Array<string> | null = [
  'SOL/igra',
  'USDC/mainnet-cctp-v2-fast',
];
```

---

## Step 4: Commit and push

```bash
cd "$REPO_PATH"
git add src/consts/warpRouteWhitelist.ts
git commit -m "feat: add <WARP_ROUTE_ID(s)> to Nexus whitelist"
git push origin <branch-name>
```

For multiple routes, list them all in the commit message: `feat: add USDS, WETH, USDT igra routes to Nexus whitelist`.

---

## Step 5: Open a PR

Target branch is `nexus` (not `main`).

For a single route:

```bash
gh pr create \
  --base nexus \
  --title "feat: add <WARP_ROUTE_ID> to Nexus whitelist" \
  --body "$(cat <<'EOF'
Adds `<WARP_ROUTE_ID>` to the Nexus UI warp route whitelist.

| Field | Value |
| ----- | ----- |
| **Linear** | [<TICKET_ID>](<LINEAR_URL>) |
| **Warp route** | `<WARP_ROUTE_ID>` |
EOF
)"
```

For multiple routes, list each route ID in the body. Combine all Linear ticket links in one row (comma-separated):

```bash
gh pr create \
  --base nexus \
  --title "feat: add <token> igra warp routes to Nexus whitelist" \
  --body "$(cat <<'EOF'
Adds the following warp routes to the Nexus UI whitelist:

| Field | Value |
| ----- | ----- |
| **Linear** | [<TICKET_ID_1>](<LINEAR_URL_1>) · [<TICKET_ID_2>](<LINEAR_URL_2>) · [<TICKET_ID_3>](<LINEAR_URL_3>) |

- `<WARP_ROUTE_ID_1>`
- `<WARP_ROUTE_ID_2>`
- `<WARP_ROUTE_ID_3>`
EOF
)"
```

Show the user the PR URL when done.
