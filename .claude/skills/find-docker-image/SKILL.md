---
name: find-docker-image
description: Find existing Docker image tags on GHCR for Hyperlane agent, monorepo, or node service images. Use when the user wants to find a recent image, look up an image for a branch or commit, or check what's currently deployed.
---

# Find Docker Images

Find existing Hyperlane Docker images on GHCR (`ghcr.io/hyperlane-xyz/*`).

## Image Repositories

| Image                     | Contents                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `hyperlane-agent`         | Rust relayer, validator, scraper                                                 |
| `hyperlane-monorepo`      | Full TS/Solidity monorepo                                                        |
| `hyperlane-node-services` | All TS node services (rebalancer, warp-monitor, ccip-server, keyfunder, relayer) |

The `hyperlane-node-services` image is a unified image. Set `SERVICE_NAME` env var at runtime to select which service to run.

## Tag Format

- **Commit tags**: `<7-char-sha>-<YYYYMMDD>-<HHMMSS>` (e.g. `c558a9f-20260304-105241`) — immutable, used in production
- **Branch tags**: `main`, `my-feature-branch` — mutable, overwritten on each build
- **PR tags**: `pr-123` — ephemeral, cleaned up after 1 week

## How to Find Images

### Latest image for a branch

Use the mutable branch tag directly:

```
ghcr.io/hyperlane-xyz/hyperlane-agent:main
```

### List all tags for an image

Query the OCI registry API (no auth needed for public images):

```bash
TOKEN=$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:hyperlane-xyz/<IMAGE>:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/hyperlane-xyz/<IMAGE>/tags/list" | jq '.tags'
```

Replace `<IMAGE>` with the image name (e.g. `hyperlane-agent`).

### Find tag for a specific commit

Grep the tag list for a sha prefix:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?service=ghcr.io&scope=repository:hyperlane-xyz/<IMAGE>:pull" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/hyperlane-xyz/<IMAGE>/tags/list" | jq -r '.tags[]' | grep '<SHA_PREFIX>'
```

### Find tag from latest workflow run

Look up the sha from the last successful build:

```bash
# Agent builds
gh run list --workflow=rust-docker.yml --branch=main --status=success --limit=1 --json headSha,createdAt --jq '.[0] | "\(.headSha[:7]) built \(.createdAt)"'

# Monorepo builds
gh run list --workflow=monorepo-docker.yml --branch=main --status=success --limit=1 --json headSha,createdAt --jq '.[0] | "\(.headSha[:7]) built \(.createdAt)"'

# Node service builds
gh run list --workflow=node-services-docker.yml --branch=main --status=success --limit=1 --json headSha,createdAt --jq '.[0] | "\(.headSha[:7]) built \(.createdAt)"'
```

Then match the sha against the GHCR tag list.

### Check what's currently deployed in production

```bash
grep -E '(tag|Tag)' typescript/infra/config/docker.ts
```

## Instructions

1. Determine what the user needs: latest for a branch, a specific commit, or what's deployed.
2. Use the appropriate method above to find the tag.
3. Return the full image reference: `ghcr.io/hyperlane-xyz/<image>:<tag>`.
4. If no image exists for their branch/commit, suggest using `/build-docker-image` to trigger one.

## References

- To trigger a new build, use the `/build-docker-image` skill.
- See `docs/docker-image-policy.md` for the full Docker image policy.
