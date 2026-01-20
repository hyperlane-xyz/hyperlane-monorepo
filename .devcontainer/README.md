# Hyperlane Development Container

A pre-configured development environment for the Hyperlane monorepo using GitHub Codespaces.

## Quick Start

### GitHub Codespaces (Recommended)

**From GitHub UI:**

1. Go to [hyperlane-xyz/hyperlane-monorepo](https://github.com/hyperlane-xyz/hyperlane-monorepo)
2. Click **Code** → **Codespaces** → **New codespace**

**From CLI:**

```bash
# Create a new Codespace
pnpm hyperagent

# Or manually with gh CLI
gh codespace create --repo hyperlane-xyz/hyperlane-monorepo
```

### Local Development (VS Code)

1. Install [Docker](https://www.docker.com/products/docker-desktop) and [VS Code](https://code.visualstudio.com/)
2. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
3. Open the monorepo in VS Code
4. Press `Cmd+Shift+P` → **"Dev Containers: Reopen in Container"**

## What's Included

The devcontainer uses the pre-built `gcr.io/abacus-labs-dev/hyperlane-monorepo` image which includes:

- **Node.js 20** with pnpm
- **Foundry** (forge, cast, anvil)
- **All dependencies pre-installed**
- **TypeScript packages pre-built**

Additional dev tools:

- **OpenCode** - AI coding agent
- **GitHub CLI** (`gh`)
- **zsh** with fzf
- Network firewall for security

## Using HyperAgent (Cloud Sessions)

HyperAgent lets you run OpenCode in a cloud Codespace and connect from your local machine.

```bash
# Create or connect to your Codespace
pnpm hyperagent

# Connect to someone else's shared Codespace
pnpm hyperagent --connect <codespace-name>

# List available Codespaces
pnpm hyperagent --list

# List sessions in connected Codespace
pnpm hyperagent --sessions

# Connect to specific session
pnpm hyperagent --session <session-id>
```

### Sharing a Codespace

1. Create your Codespace: `pnpm hyperagent`
2. Share the Codespace name with teammates (shown in output)
3. Teammates connect: `pnpm hyperagent --connect <your-codespace-name>`

Port visibility is set to `org` so only GitHub org members can connect.

## Firewall

The devcontainer includes a strict network firewall that only allows outbound connections to whitelisted domains:

- npm registry
- GitHub
- Hyperlane services
- Google Cloud APIs
- Notion & Linear APIs

To allow RPC provider access (for integration testing), set:

```bash
export DEVCONTAINER_FIREWALL_MODE=relaxed
```

## VS Code Extensions

Automatically installed:

- ESLint
- Prettier
- GitLens
- Hardhat Solidity

## Troubleshooting

### Codespace takes a long time to start

The base image is pre-built, so startup should be fast (~1-2 minutes). If it's slow:

- Check if Codespace prebuilds are enabled
- Try a fresh Codespace: `gh codespace delete -c <name> && pnpm hyperagent`

### OpenCode server not running

Check the server logs:

```bash
cat /tmp/opencode-server.log
```

Restart the server:

```bash
opencode serve --port 4096 --hostname 0.0.0.0 &
```

### Firewall blocking a domain

Temporarily disable or add the domain to `init-firewall.sh`.

## Resources

- [VS Code Dev Containers](https://code.visualstudio.com/docs/devcontainers/containers)
- [GitHub Codespaces](https://docs.github.com/en/codespaces)
- [OpenCode Docs](https://opencode.ai/docs)
