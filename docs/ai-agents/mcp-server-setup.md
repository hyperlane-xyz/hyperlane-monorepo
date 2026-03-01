# MCP Server Setup

Quick setup guide for MCP servers used by the Abacus Works team.

## Prerequisites

1. Create credentials directory for some required keys (described later for the relevant MCP servers):

```bash
mkdir -p ~/.mcp
```

2. **Make sure Docker is running!** Some of these MCP servers require Docker to be running and won't start otherwise.

## Setup MCP servers

### Google Cloud MCP Server

1. Get a service account key from GCP (or copy your existing one from `~/.config/gcloud/application_default_credentials.json`), and put it in `~/.mcp/claude-logging-key.json`.
2. Run the following command:

```bash
claude mcp add --scope user google-cloud-mcp -- docker run -i \
  -e GOOGLE_APPLICATION_CREDENTIALS=/credentials/gcp-service-key.json \
  -e GOOGLE_CLOUD_PROJECT=abacus-labs-dev \
  -v ~/.mcp/gcp-service-key.json:/credentials/gcp-service-key.json \
  us-east1-docker.pkg.dev/abacus-labs-dev/hyperlane/mcp-google-cloud:latest
```

### Grafana MCP Server

1. Go to [https://abacusworks.grafana.net](https://abacusworks.grafana.net)
2. On the left, find "Administration -> Users and access -> Service accounts"
3. Click "Add a service account"
4. Add a name like "yourname-mcp", and give it the Viewer role, and create it
5. Then click "Add service account token", and copy this into your local `~/.mcp/grafana-service-account.key`
6. Run the following command:

```bash
claude mcp add --scope user grafana -- docker run -i \
  -e GRAFANA_URL=https://abacusworks.grafana.net/ \
  -e GRAFANA_API_KEY=$(cat ~/.mcp/grafana-service-account.key) \
  mcp/grafana -t stdio
```

### Hyperlane Explorer MCP Server

```bash
claude mcp add --scope user hyperlane-explorer -- docker run -i \
  -e ENDPOINT=https://explorer4.hasura.app/v1/graphql \
  -e SCHEMA=/usr/src/app/schema/hyperlane-schema.graphql \
  us-east1-docker.pkg.dev/abacus-labs-dev/hyperlane/mcp-graphql:latest
```

### Notion MCP Server

1. Run the following command (you still need to authenticate after this!):

```bash
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
```

2. Now run `claude`
3. Inside claude, run `/mcp`
4. Select `notion`
5. Authenticate - it'll bring you to the browser. Select the right workspace, and it should use a webhook to finish the authentication.

## Verification

```bash
claude mcp list
# All servers should show "✓ Connected"
```
