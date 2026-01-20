# Hyperlane Development Containers

This directory contains devcontainer configurations for developing the Hyperlane monorepo in isolated, reproducible environments.

## Available Variants

| Variant        | Includes                   | Use Case                               |
| -------------- | -------------------------- | -------------------------------------- |
| **typescript** | Node.js 20, pnpm, OpenCode | SDK, CLI, infra work                   |
| **solidity**   | Above + Foundry            | Solidity contracts + TypeScript        |
| **full**       | Above + Rust 1.88.0        | Full development including Rust agents |

## Quick Start

### VS Code (Local)

1. Install [Docker](https://www.docker.com/products/docker-desktop) and [VS Code](https://code.visualstudio.com/)
2. Install the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
3. Open the monorepo in VS Code
4. Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
5. Select **"Dev Containers: Reopen in Container"**
6. Choose a variant (typescript, solidity, or full)

### GitHub Codespaces

**From GitHub UI:**

1. Go to the [Hyperlane monorepo](https://github.com/hyperlane-xyz/hyperlane-monorepo)
2. Click **Code** → **Codespaces** → **New codespace**
3. Select your preferred variant from the devcontainer dropdown

**From CLI:**

```bash
# Create a new codespace with the typescript variant
gh codespace create --repo hyperlane-xyz/hyperlane-monorepo \
  --devcontainer-path .devcontainer/typescript/devcontainer.json

# List your codespaces
gh codespace list

# Connect via SSH
gh codespace ssh -c <codespace-name>

# Open in VS Code
gh codespace code -c <codespace-name>
```

### JetBrains IDEs

JetBrains Gateway supports devcontainers. See [JetBrains documentation](https://www.jetbrains.com/help/idea/connect-to-devcontainer.html).

### CLI Only

```bash
# Install devcontainer CLI
npm install -g @devcontainers/cli

# Build and start
devcontainer up --workspace-folder .

# Execute commands
devcontainer exec --workspace-folder . bash
```

## Configuration

### API Keys (Required for OpenCode)

Set your Anthropic API key as a Codespaces secret:

1. Go to [GitHub Settings → Codespaces → Secrets](https://github.com/settings/codespaces)
2. Add `ANTHROPIC_API_KEY` with your API key
3. Grant access to the hyperlane-monorepo

For local development, set the environment variable:

```bash
export ANTHROPIC_API_KEY=your-api-key
```

### Firewall Modes

The devcontainer includes a strict firewall that only allows outbound connections to whitelisted domains. Two modes are available:

| Mode                 | Description                                     | Use Case                             |
| -------------------- | ----------------------------------------------- | ------------------------------------ |
| **strict** (default) | Only essential domains (npm, GitHub, GCP, etc.) | Most development work                |
| **relaxed**          | Adds RPC provider domains                       | Integration testing with real chains |

To enable relaxed mode, set the environment variable before starting the container:

```bash
export DEVCONTAINER_FIREWALL_MODE=relaxed
```

Or in your `devcontainer.json`:

```json
{
  "containerEnv": {
    "DEVCONTAINER_FIREWALL_MODE": "relaxed"
  }
}
```

### Whitelisted Domains

**Always allowed:**

- `registry.npmjs.org` - npm packages
- `github.com`, `api.github.com` - Git operations
- `crates.io`, `static.crates.io` - Rust crates
- `api.anthropic.com` - OpenCode/Claude API
- `*.hyperlane.xyz` - Hyperlane services
- `*.googleapis.com` - Google Cloud
- `api.notion.com` - Notion API
- `api.linear.app` - Linear API
- VS Code marketplace domains

**Relaxed mode only (RPC providers):**

- `*.alchemyapi.io`, `*.alchemy.com`
- `*.quiknode.pro`
- `*.infura.io`
- `rpc.ankr.com`
- `*.llamarpc.com`
- `*.drpc.org`

## Tools Included

All variants include:

- **Node.js 20** with pnpm
- **Git** with git-delta for better diffs
- **ZSH** with fzf and productivity plugins
- **GitHub CLI** (`gh`)
- **Google Cloud SDK** (`gcloud`)
- **OpenCode** CLI

Additional tools by variant:

- **solidity**: Foundry (forge, cast, anvil)
- **full**: Rust 1.88.0 with clippy and rustfmt

## VS Code Extensions

Extensions are automatically installed based on variant:

| Extension        | typescript | solidity | full |
| ---------------- | ---------- | -------- | ---- |
| ESLint           | ✓          | ✓        | ✓    |
| Prettier         | ✓          | ✓        | ✓    |
| GitLens          | ✓          | ✓        | ✓    |
| Hardhat Solidity |            | ✓        | ✓    |
| rust-analyzer    |            |          | ✓    |

## Troubleshooting

### Firewall blocking a domain

If you need to access a domain not in the whitelist:

1. **Temporary**: Use relaxed mode
2. **Permanent**: Add the domain to `shared/init-firewall.sh` and rebuild

### Container build fails

```bash
# Clean Docker cache and rebuild
docker system prune -a
devcontainer build --workspace-folder . --no-cache
```

### Slow Codespaces startup

Prebuilds should make startup fast (~30 seconds). If slow:

1. Check if prebuilds are enabled for the repo
2. Ensure you're using a pre-built branch (usually `main`)

### Permission denied errors

The container runs as the `node` user. If you encounter permission issues:

```bash
# Inside container
sudo chown -R node:node /workspace
```

## Security Notes

The firewall provides network isolation but is not a complete security boundary:

- A malicious project could potentially exfiltrate data accessible within the container
- Only use devcontainers with trusted repositories
- Monitor OpenCode's activities when using `--dangerously-skip-permissions`

## Contributing

To modify devcontainer configurations:

1. Edit files in `.devcontainer/<variant>/`
2. Update `shared/init-firewall.sh` for firewall changes (then copy to each variant)
3. Test locally with `devcontainer build`
4. Submit a PR

## Resources

- [VS Code Dev Containers docs](https://code.visualstudio.com/docs/devcontainers/containers)
- [GitHub Codespaces docs](https://docs.github.com/en/codespaces)
- [Devcontainer specification](https://containers.dev/)
- [Claude Code devcontainer reference](https://github.com/anthropics/claude-code/tree/main/.devcontainer)
