---
name: add-registry-changeset
description: Write a changeset file in the `hyperlane-registry` repo for a PR that adds, updates, or modifies warp route config / chain metadata / addresses. Canonical pattern — never run the interactive `pnpm changeset` CLI; write the file directly. Referenced by any skill that opens a registry PR.
---

# Add a Registry Changeset

The `hyperlane-registry` repo uses changesets to track PR-level changes and drive npm releases of `@hyperlane-xyz/registry`. Every PR that touches the published surface (warp route configs, chain metadata, addresses, deployments) MUST carry a changeset, otherwise the merge bot blocks the PR and the published package falls behind. Skills that open registry PRs invoke this skill to write the changeset before committing.

## Why a dedicated skill

- Single source of truth for filename / frontmatter / style / semver-bump conventions.
- Avoids per-skill drift — fresh deploys, route updates, chain extensions, address backfills, logo updates all need the same shape; encode it once.
- Closes the recurring miss where the PR-opening was done ad-hoc (user prompts the agent to "open a registry PR") and the agent forgets the changeset because it isn't in the parent skill's checklist.

## Input

- **Change summary** (required) — one short sentence describing what the PR does. Past tense, lowercase, concise (CLAUDE.md style for changesets).
- **Bump type** (required) — `minor` for new warp routes / new chains / new published assets; `patch` for updates / fixes / metadata tweaks to existing entries.
- **Filename slug** (optional) — short kebab-case identifier; if not provided, the agent picks a slug derived from the PR scope (e.g. `add-ikas-ethereum-igra`, `update-eth-arbitrum-base-fee-11bps`, `fix-katana-rpc`). The auto-generated `<adjective>-<noun>-<verb>.md` names that the interactive CLI emits are also acceptable but discouraged — descriptive slugs are easier to scan in PR diffs.

## Step 1: Confirm the Registry Path

The changeset must be written to the `hyperlane-registry` checkout, NOT the monorepo. Determine the registry path:

```bash
REGISTRY_PATH="${HYPERLANE_REGISTRY:-$HOME/hyperlane-registry}"
ls -d "$REGISTRY_PATH/.changeset" || { echo "Registry .changeset/ missing — wrong path?" >&2; exit 1; }
```

If the registry checkout isn't at the expected location, surface the discrepancy to the user before continuing.

## Step 2: Choose the Filename

Use the provided slug, OR derive one from the PR scope:

| PR scope                                             | Filename example                            |
| ---------------------------------------------------- | ------------------------------------------- |
| New warp route deploy                                | `add-<token>-<chains>.md`                   |
| Warp route config update (fees / ISM / hook / owner) | `update-<token>-<chains>-<short-change>.md` |
| Adding a chain                                       | `add-<chain>.md`                            |
| Updating chain metadata (RPCs, blocks, logo, etc.)   | `update-<chain>-<short-change>.md`          |
| Fix / backfill                                       | `fix-<short-description>.md`                |

The file must be `*.md` and live directly under `.changeset/`. The registry `.changeset/config.json` enforces the schema.

## Step 3: Write the File

The content has TWO parts: a YAML frontmatter block specifying the package + bump, then a free-form markdown body that becomes the changelog entry on publish.

```markdown
---
'@hyperlane-xyz/registry': <bump>
---

<change summary — one or two sentences, past tense, lowercase, concise>
```

**Bump rules**:

- `minor` — added something new that downstream consumers will start seeing (new warp route, new chain, new published asset).
- `patch` — modified or fixed an existing entry (fee change on an existing route, RPC update, ICA address backfill, logo swap).

**Style** — per CLAUDE.md:

> Write changeset descriptions in past tense describing what changed.
> Good: "The registry code is restructured by moving filesystem components to a dedicated directory."
> Bad: "Restructures the registry code."

Lowercase first letter, no terminal period if it's a single short sentence. Multi-sentence summaries can use sentence case.

## Step 4: Validate

Inspect the file before staging:

```bash
cat "$REGISTRY_PATH/.changeset/<filename>"
```

Confirm:

- Frontmatter has exactly one package entry: `'@hyperlane-xyz/registry': <bump>`
- Bump value matches the rule above
- Body is one or two sentences in the right tense + voice
- No secrets / private RPC URLs leaked into the body

## Step 5: Hand Back to the Calling Skill

Return control to the caller. The caller is responsible for staging the changeset alongside the PR's other files:

```bash
cd $REGISTRY_PATH
git add .changeset/<filename>
# … plus the warp route config / chain metadata files specific to the change
git commit -m "<commit message scoped to the change>"
```

**Do NOT use `git add .` or `git add -A`** in the registry checkout. Scope to the changeset + the specific files the PR touches. If a warp apply run was done with the HTTP registry in writeMode, unrelated files may have been written by the server — staging them blindly risks publishing API-keyed RPC overrides. Always run `git status` first and review the file list before staging.

---

## Notes

- **Do NOT run `pnpm changeset` (the interactive CLI)** — its prompts hang in headless / agent environments and produce auto-generated `<adjective>-<noun>-<verb>.md` names that are less informative. Writing the file directly is faster and produces better history.
- The auto-generated filename pattern is acceptable if the registry's CI rejects custom slugs for some reason, but in practice the `.changeset/config.json` doesn't enforce a naming pattern beyond the `.md` extension.
- For consumers: `/warp-deploy-update-owners` Step 12 (fresh-deploy PR), `/warp-update` post-broadcast registry PR step, any chain-metadata update skill.
