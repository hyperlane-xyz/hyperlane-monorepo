# MCP Server Setup Rules

## Reference

See `docs/ai-agents/mcp-server-setup.md` for full setup commands.

## Available MCP Servers

| Server               | Purpose                       |
| -------------------- | ----------------------------- |
| `google-cloud-mcp`   | GCP logging queries           |
| `grafana`            | Grafana dashboards and alerts |
| `hyperlane-explorer` | Message status queries        |
| `notion`             | Documentation access          |

## Verify Setup

```bash
claude mcp list
# All servers should show "✓ Connected"
```

## Required Credentials

- `~/.mcp/gcp-service-key.json` - Google Cloud service account key
- `~/.mcp/grafana-service-account.key` - Grafana API key
