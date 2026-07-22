---
name: registry-yaml-sort-policy
description: The alphabetical-sort invariants the hyperlane-registry CI / CodeRabbit enforces on warp route YAML (deploy.yaml and config.yaml) — top-level chain entries sorted by chain name, and keys within each entry in strict alphabetical order — plus the canonical per-file key orderings and a verification pass. Referenced by any warp deploy/update skill that writes or edits a registry YAML file.
---

# Registry YAML Sort Policy

The `hyperlane-registry` CI (and CodeRabbit) reject a PR whose warp route YAML isn't alphabetically sorted on two levels. Every skill that writes or edits a `deploy.yaml` or `config.yaml` must satisfy both invariants before showing the file for review or committing, so this is the single source of the rule and the canonical key orders.

## The two invariants

1. **Top-level chain entries must be in alphabetical order by chain name.** E.g. an arbitrum + base + ethereum route has `arbitrum:` before `base:` before `ethereum:`. When inserting a new chain or restructuring a file, re-sort the top level by chain name — insert at the alphabetical position, never at the top or bottom.
2. **Keys within each chain entry must be in strict alphabetical order.** When adding a field, insert it at its alphabetical position — never at the top, the bottom, or "after a specific sibling key".

## Canonical key orders

These are the alphabetical orderings for the two file types (use them as the visual reference when inserting a key):

- **`deploy.yaml`** token entry: `decimals`, `mailbox`, `name`, `owner`, `symbol`, `token`, `tokenFee`, `type`. (Additional keys — e.g. `hook`, `interchainSecurityModule`, `gas`, `collateralChainName` — slot in at their own alphabetical position.)
- **`config.yaml`** token block: `addressOrDenom`, `chainName`, `coinGeckoId`, `connections`, `decimals`, `logoURI`, `name`, `standard`, `symbol`, `tokenType`.

Any key not listed slots in at its own alphabetical position; the lists above are the common cases, not an exhaustive schema.

## Verify before review / commit

Before showing the file for review (or committing), confirm both invariants on the final file:

- Top-level chain entries are alphabetical by chain name.
- Within each chain's block, keys are alphabetical (a visual scan against the canonical order above is enough; for stronger confidence pipe the file through `yq` and compare against a sorted rendering).

If either invariant fails, fix the file first — CI / CodeRabbit will otherwise block the PR.

## Consumers

`/warp-deploy-init-route` (deploy.yaml generation), `/warp-deploy-update-owners` (config.yaml finalize), `/warp-update` (deploy.yaml edits), `/warp-update-extend` (new-chain deploy.yaml entry).
