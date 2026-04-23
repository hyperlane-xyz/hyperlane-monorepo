# Docker Image Policy

## Registry

All images publish to **GHCR**: `ghcr.io/hyperlane-xyz/*`

GCR (`gcr.io/abacus-labs-dev`) is deprecated. A 30-day cleanup policy is applied to the old repo.

## Images

| Workflow                   | Image(s)                  | Contents                                                                                 |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `rust-docker.yml`          | `hyperlane-agent`         | Rust relayer, validator, scraper                                                         |
| `monorepo-docker.yml`      | `hyperlane-monorepo`      | Full TS/Solidity monorepo                                                                |
| `node-services-docker.yml` | `hyperlane-node-services` | All TypeScript node services (rebalancer, warp-monitor, ccip-server, keyfunder, relayer) |
| `simapp-docker.yml`        | `hyperlane-cosmos-simapp` | Cosmos simapp (manual only)                                                              |

### Node Services Image

The `hyperlane-node-services` image is a single unified image containing all TypeScript service bundles. At runtime, set the `SERVICE_NAME` environment variable to select which service to run:

| SERVICE_NAME   | Service                    |
| -------------- | -------------------------- |
| `rebalancer`   | Warp route rebalancer      |
| `warp-monitor` | Warp route balance monitor |
| `ccip-server`  | Offchain lookup server     |
| `keyfunder`    | Agent key funder           |
| `relayer`      | TypeScript relayer         |
| `fee-quoting`  | Fee-quoting server         |

## Tagging

Format: `<7-char-sha>-<YYYYMMDD>-<HHMMSS>`
Example: `c558a9f-20260304-105241`

Additional tags applied automatically:

- **Branch name** (e.g., `main`)
- **PR number** (e.g., `pr-123`)
- **Git tag** (e.g., `v2.1.0`); agent releases use `agents-*` tags which also produce semver tags

## Verification

All images pushed by `rust-docker.yml`, `monorepo-docker.yml`, and `node-services-docker.yml` carry a SLSA v1 build-provenance attestation, signed keyless via GitHub Actions OIDC and attached to the image digest as an OCI referrer.

The attestation identifies:

- repository: `hyperlane-xyz/hyperlane-monorepo`
- workflow: the producing `.github/workflows/*.yml`
- commit SHA
- runner / builder
- `startedOn` / `finishedOn` build timestamps

### Verify with `gh`

```bash
gh attestation verify \
  oci://ghcr.io/hyperlane-xyz/hyperlane-agent:<tag-or-digest> \
  --repo hyperlane-xyz/hyperlane-monorepo
```

Add `--signer-workflow hyperlane-xyz/hyperlane-monorepo/.github/workflows/rust-docker.yml` to pin the producing workflow.

### Verify with `cosign`

```bash
cosign verify-attestation \
  --type slsaprovenance1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/hyperlane-xyz/hyperlane-monorepo/\.github/workflows/rust-docker\.yml@' \
  ghcr.io/hyperlane-xyz/hyperlane-agent@<digest>
```

### Minimum build age (soak time)

Provenance timestamps enable a "cool-off" gate in promotion pipelines. Extract `finishedOn` and compare against `now - soak`:

```bash
FINISHED=$(cosign verify-attestation \
  --type slsaprovenance1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/hyperlane-xyz/hyperlane-monorepo/\.github/workflows/rust-docker\.yml@' \
  ghcr.io/hyperlane-xyz/hyperlane-agent@<digest> \
  | jq -r '.payload | @base64d | fromjson | .predicate.runDetails.metadata.finishedOn')

AGE=$(( $(date -u +%s) - $(date -u -d "$FINISHED" +%s) ))
[ "$AGE" -ge 86400 ] || { echo "image younger than 24h"; exit 1; }
```

Staging typically needs no soak; production can require ≥24h.

### Pin deploys by digest

Tags are mutable. For verification guarantees to hold end-to-end, promotion/deploy should resolve tag → digest once, verify the digest, then deploy the digest. See `typescript/infra/config/docker.ts` for the deployed-tag surface.

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

| Workflow                   | Trigger paths                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `rust-docker.yml`          | `rust/Dockerfile`, `rust/main/Cargo.lock`, `.dockerignore`, workflow file                                    |
| `monorepo-docker.yml`      | `Dockerfile`, `docker-entrypoint.sh`, `pnpm-lock.yaml`, `.registryrc`, `.dockerignore`, workflow file        |
| `node-services-docker.yml` | `typescript/Dockerfile`, `typescript/docker-entrypoint.sh`, `pnpm-lock.yaml`, `.dockerignore`, workflow file |

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
| `typescript/docker-entrypoint.sh`            | Entrypoint script for service selection     |
| `rust/main/helm/hyperlane-agent/values.yaml` | Helm chart defaults                         |
