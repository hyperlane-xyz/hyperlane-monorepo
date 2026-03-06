# Hyperlane Helm Charts

This directory contains the Helm charts used to deploy Hyperlane Rust agents on
Kubernetes.

## Charts

- `hyperlane-agent`: deploys Hyperlane validator, relayer, and scraper agents
- `agent-common`: shared helper templates used by `hyperlane-agent`

`agent-common` is a library chart dependency and is not intended to be
installed directly.

## Local Validation

From the repository root:

```bash
helm dependency build rust/main/helm/hyperlane-agent
helm lint rust/main/helm/agent-common
helm lint rust/main/helm/hyperlane-agent
```

## Published Repository

The Helm publication workflow writes packaged charts and `index.yaml` to the
`gh-pages` branch.

Once GitHub Pages is configured to serve `gh-pages` from the repository root,
the published chart repository URL will be:

```bash
https://hyperlane-xyz.github.io/hyperlane-monorepo
```

Consumers can then install the chart with:

```bash
helm repo add hyperlane https://hyperlane-xyz.github.io/hyperlane-monorepo
helm repo update
helm install my-agent hyperlane/hyperlane-agent --version 0.1.0
```

## Releasing Chart Changes

When chart contents change, bump the corresponding `version` in `Chart.yaml`
before merging to `main`. Helm repositories publish immutable chart versions, so
the workflow can only release a chart when its version changes.
