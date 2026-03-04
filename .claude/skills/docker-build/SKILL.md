---
name: docker-build
description: Trigger Docker image builds for Hyperlane agent, monorepo, or node service images. Use when the user wants to build new Docker images for a branch, commit, or tag.
---

# Trigger Docker Image Builds

Build and publish Docker images to GHCR (`ghcr.io/hyperlane-xyz/*`).

## Workflows

| Workflow                   | Image(s)                                                                                                                             | Contents                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `rust-docker.yml`          | `hyperlane-agent`                                                                                                                    | Rust relayer, validator, scraper |
| `monorepo-docker.yml`      | `hyperlane-monorepo`                                                                                                                 | Full TS/Solidity monorepo        |
| `node-services-docker.yml` | `hyperlane-rebalancer`, `hyperlane-warp-monitor`, `hyperlane-key-funder`, `hyperlane-ts-relayer`, `hyperlane-offchain-lookup-server` | TypeScript node services         |

## How to Trigger

Use `gh workflow run` with `--ref` to specify the branch, tag, or commit:

```bash
# Agent image (Rust)
gh workflow run rust-docker.yml --ref <branch>

# Monorepo image
gh workflow run monorepo-docker.yml --ref <branch>

# Node services (all 5 built together)
gh workflow run node-services-docker.yml --ref <branch>

# Include arm64 (multi-arch, slower)
gh workflow run rust-docker.yml --ref <branch> -f include_arm64=true
```

`--ref` defaults to `main` if omitted.

## After Triggering

1. Get the run URL:

   ```bash
   gh run list --workflow=<workflow>.yml --limit=1 --json url --jq '.[].url'
   ```

2. Watch it:

   ```bash
   gh run watch --workflow=<workflow>.yml
   ```

3. The resulting image tag will be `<7-char-sha>-<YYYYMMDD>-<HHMMSS>`, e.g. `c558a9f-20260304-105241`.

4. Images are at `ghcr.io/hyperlane-xyz/<image-name>:<tag>`.

## Instructions

1. Ask the user which image(s) they want to build (agent, monorepo, node services, or all).
2. Ask which branch/ref (default: `main`).
3. Ask if arm64 is needed (default: no).
4. Trigger the workflow(s) with `gh workflow run`.
5. Fetch and report the run URL(s) using `gh run list`.
6. Optionally watch for completion if the user wants to wait.

## References

- To find existing images instead of building, use the `/docker-image` skill.
- See `docs/docker-image-policy.md` for the full Docker image policy.
