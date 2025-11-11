# MCP Server Setup

Quick setup guide for MCP servers used by the Abacus Works team.

## Prerequisites

Create credentials directory and add required keys:

```bash
mkdir -p ~/.mcp
# Add your Google Cloud service account key to ~/.mcp/claude-logging-key.json
# Add your Grafana API key to ~/.mcp/grafana-service-account.key
```

## Setup Commands

### Google Cloud MCP Server

```bash
claude mcp add google-cloud-mcp -- docker run -i \
  -e GOOGLE_APPLICATION_CREDENTIALS=/credentials/gcp-service-key.json \
  -e GOOGLE_CLOUD_PROJECT=abacus-labs-dev \
  -v ~/.mcp/gcp-service-key.json:/credentials/gcp-service-key.json \
  us-east1-docker.pkg.dev/abacus-labs-dev/hyperlane/mcp-google-cloud:latest
```

### Grafana MCP Server

```bash
claude mcp add grafana -- docker run -i \
  -e GRAFANA_URL=https://abacusworks.grafana.net/ \
  -e GRAFANA_API_KEY=$(cat ~/.mcp/grafana-service-account.key) \
  mcp/grafana -t stdio
```

### Hyperlane Explorer MCP Server

```bash
claude mcp add hyperlane-explorer -- docker run -i \
  -e ENDPOINT=https://explorer4.hasura.app/v1/graphql \
  -e SCHEMA=/usr/src/app/schema/hyperlane-schema.graphql \
  us-east1-docker.pkg.dev/abacus-labs-dev/hyperlane/mcp-graphql:latest
```

### Notion MCP Server

```bash
claude mcp add notion https://mcp.notion.com/mcp
```

## Verification

```bash
claude mcp list
# All servers should show "✓ Connected"
```
