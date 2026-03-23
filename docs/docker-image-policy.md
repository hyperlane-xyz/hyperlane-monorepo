# Docker Image Policy

## Registry

All images publish to **GHCR**: `ghcr.io/hyperlane-xyz/*`

GCR (`gcr.io/abacus-labs-dev`) is deprecated. A 30-day cleanup policy is applied to the old repo.

## Images

| Workflow                   | Image(s)                                                                                                                             | Contents                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `rust-docker.yml`          | `hyperlane-agent`                                                                                                                    | Rust relayer, validator, scraper |
| `monorepo-docker.yml`      | `hyperlane-monorepo`                                                                                                                 | Full TS/Solidity monorepo        |
| `node-services-docker.yml` | `hyperlane-rebalancer`, `hyperlane-warp-monitor`, `hyperlane-key-funder`, `hyperlane-ts-relayer`, `hyperlane-offchain-lookup-server` | TypeScript node services         |
| `simapp-docker.yml`        | `hyperlane-cosmos-simapp`                                                                                                            | Cosmos simapp (manual only)      |

## Tagging

Format: `<7-char-sha>-<YYYYMMDD>-<HHMMSS>`
Example: `c558a9f-20260304-105241`

Additional tags applied automatically:

- **Branch name** (e.g., `main`)
- **PR number** (e.g., `pr-123`)
- **Git tag** (e.g., `v2.1.0`); agent releases use `agents-*` tags which also produce semver tags

## Retention

| Image type                           | Retention                       | Notes                         |
| ------------------------------------ | ------------------------------- | ----------------------------- |
| Branch/tag builds (`main`, `v2.1.0`) | Permanent                       |                               |
| Commit-hash tags (`c558a9f-...`)     | Permanent                       | Used in production deploys    |
| PR images (`pr-*`)                   | **1 week** (5 most recent kept) | Cleaned by `ghcr-cleanup.yml` |
| Untagged/dangling                    | **1 week**                      | Cleaned by `ghcr-cleanup.yml` |

Cleanup runs weekly (Sunday midnight UTC) via `.github/workflows/ghcr-cleanup.yml`.

## Build Triggers

Builds are **not** triggered automatically on every PR or merge to main. They only fire when Docker build infrastructure files change:

| Workflow                   | Trigger paths                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `rust-docker.yml`          | `rust/Dockerfile`, `rust/main/Cargo.lock`, `.dockerignore`, workflow file                                            |
| `monorepo-docker.yml`      | `Dockerfile`, `docker-entrypoint.sh`, `pnpm-lock.yaml`, `.registryrc`, `.dockerignore`, workflow file                |
| `node-services-docker.yml` | `typescript/Dockerfile.node-service`, `typescript/docker-bake.hcl`, `pnpm-lock.yaml`, `.dockerignore`, workflow file |

Additionally:

- `rust-docker.yml` fires on `agents-*` tags (releases)
- All workflows support `workflow_dispatch` (manual trigger)

## Manual Builds

Via UI:

- https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/workflows/rust-docker.yml
- https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/workflows/monorepo-docker.yml
- https://github.com/hyperlane-xyz/hyperlane-monorepo/actions/workflows/node-services-docker.yml

Via `gh` CLI:

```bash
# Agent image
gh workflow run rust-docker.yml --ref <branch>

# Monorepo image
gh workflow run monorepo-docker.yml --ref <branch>

# Node services
gh workflow run node-services-docker.yml --ref <branch>

# With arm64 support
gh workflow run rust-docker.yml --ref <branch> -f include_arm64=true

# Check the run
gh run list --workflow=rust-docker.yml --limit=1 --json url --jq '.[].url'
```

## Kubernetes Pull Policy

`imagePullPolicy: IfNotPresent` — safe because all deployed tags are immutable commit hashes.

## Key Files

| File                                         | Purpose                                     |
| -------------------------------------------- | ------------------------------------------- |
| `typescript/infra/config/docker.ts`          | Registry config, image names, deployed tags |
| `.github/workflows/ghcr-cleanup.yml`         | GHCR retention workflow                     |
| `typescript/infra/src/utils/gcloud.ts`       | `checkDockerTagExists()`, `warnIfPrTag()`   |
| `typescript/docker-bake.hcl`                 | Docker Bake config for node services        |
| `rust/main/helm/hyperlane-agent/values.yaml` | Helm chart defaults                         |
