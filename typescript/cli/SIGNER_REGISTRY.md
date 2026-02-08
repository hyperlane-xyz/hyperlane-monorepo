# Signer Registry

This document describes the signer registry feature that allows CLI users to configure signers via registry files instead of passing private keys directly through command-line arguments.

## Overview

The signer registry provides a more secure and flexible way to configure signers for Hyperlane CLI commands. Instead of passing `--key <private-key>` on the command line (which can expose keys in shell history), you can:

1. Define signers in YAML configuration files
2. Reference environment variables for sensitive data
3. Use external key management services (GCP Secret Manager, Turnkey, etc.)
4. Configure different signers per chain or protocol

## Quick Start

### 1. Create a Signer Configuration File

Create a directory for your signer registry and add a YAML configuration:

```bash
mkdir -p ~/.hyperlane/signers
```

Create `~/.hyperlane/signers/default.yaml`:

```yaml
signers:
  dev:
    type: rawKey
    privateKeyEnvVar: HYP_KEY

defaults:
  default:
    ref: dev
```

### 2. Use the Signer Registry

Run CLI commands with your signer registry:

```bash
# Set your private key in an environment variable
export HYP_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Run a command using the signer from registry
hyperlane send message \
  --registry https://github.com/hyperlane-xyz/hyperlane-registry \
  --registry ~/.hyperlane \
  --origin ethereum \
  --destination polygon
```

## Signer Types

### Raw Key (`rawKey`)

Use a private key directly or from an environment variable.

```yaml
signers:
  # Direct private key (not recommended for production)
  direct:
    type: rawKey
    privateKey: "0x..."

  # From environment variable (recommended)
  from-env:
    type: rawKey
    privateKeyEnvVar: MY_PRIVATE_KEY
```

### GCP Secret Manager (`gcpSecret`)

Fetch a private key from Google Cloud Secret Manager at runtime.

```yaml
signers:
  prod-deployer:
    type: gcpSecret
    project: my-gcp-project
    secretName: hyperlane-deployer-key
```

Requirements:
- Install the `gcloud` CLI: https://cloud.google.com/sdk/docs/install
- Authenticate: `gcloud auth application-default login`

### Turnkey (`turnkey`)

Use Turnkey's secure signing service.

```yaml
signers:
  turnkey-signer:
    type: turnkey
    organizationId: "org-xxx"
    apiPublicKey: "..."
    apiPrivateKey: "..."
    privateKeyId: "key-xxx"
    publicKey: "0x..."
```

### Foundry Keystore (`foundryKeystore`)

Use a Foundry-compatible encrypted keystore file.

```yaml
signers:
  foundry-account:
    type: foundryKeystore
    accountName: my-account
    # Optional: custom keystore path (defaults to ~/.foundry/keystores)
    keystorePath: /path/to/keystores
    # Optional: path to password file (recommended)
    passwordFile: /path/to/password-file
    # Optional: env var containing password directly (for testing)
    passwordEnvVar: MY_KEYSTORE_PASSWORD
```

Password resolution order:
1. `passwordFile` - path to a file containing the password
2. `passwordEnvVar` - environment variable containing the password directly
3. `ETH_PASSWORD` - Foundry standard: env var pointing to password file path

Example using Foundry standard:
```bash
# Create password file
echo "my-secret-password" > ~/.keystore-password

# Set Foundry standard env var
export ETH_PASSWORD=~/.keystore-password

# Now the keystore can be decrypted automatically
hyperlane send message --registry foundry://my-account ...
```

## Configuration Structure

### Full Configuration Example

```yaml
# Named signer definitions
signers:
  dev:
    type: rawKey
    privateKeyEnvVar: DEV_KEY

  prod:
    type: gcpSecret
    project: my-project
    secretName: prod-deployer

  turnkey-deployer:
    type: turnkey
    organizationId: "..."
    apiPublicKey: "..."
    apiPrivateKey: "..."
    privateKeyId: "..."
    publicKey: "0x..."

# Hierarchical defaults
defaults:
  # Default signer for all chains
  default:
    ref: dev

  # Protocol-specific overrides
  protocols:
    ethereum:
      ref: prod
    sealevel:
      ref: turnkey-deployer

  # Chain-specific overrides (highest priority)
  chains:
    ethereum:
      ref: prod
    arbitrum:
      type: rawKey
      privateKeyEnvVar: ARBITRUM_KEY
```

### Resolution Order

When determining which signer to use for a chain, the system checks in this order:

1. **Chain-specific** (`defaults.chains.<chainName>`) - highest priority
2. **Protocol-specific** (`defaults.protocols.<protocol>`)
3. **Default** (`defaults.default`) - lowest priority
4. **Fallback to `--key`** argument if no registry signer found

## Signer Registry URIs

For simple use cases, you can use special registry URI formats to quickly configure signers without creating YAML files.

### GCP Secret Manager URI

```bash
hyperlane send message \
  --registry https://github.com/hyperlane-xyz/hyperlane-registry \
  --registry gcp://my-project/my-secret-name \
  --origin ethereum \
  --destination polygon
```

This is equivalent to:

```yaml
signers:
  default:
    type: gcpSecret
    project: my-project
    secretName: my-secret-name

defaults:
  default:
    ref: default
```

### Foundry Keystore URI

```bash
# Using default keystore path (~/.foundry/keystores)
hyperlane send message \
  --registry https://github.com/hyperlane-xyz/hyperlane-registry \
  --registry foundry://my-account \
  --origin ethereum \
  --destination polygon

# Using custom keystore path
hyperlane send message \
  --registry foundry:///path/to/keystores/my-account \
  ...
```

This is equivalent to:

```yaml
signers:
  default:
    type: foundryKeystore
    accountName: my-account

defaults:
  default:
    ref: default
```

Remember to set `ETH_PASSWORD` to the path of your password file (Foundry standard).

## Merging Multiple Registries

You can specify multiple `--registry` arguments. Registries are merged in order, with later registries overriding earlier ones:

```bash
hyperlane send message \
  --registry https://github.com/hyperlane-xyz/hyperlane-registry \  # Chain metadata
  --registry ~/.hyperlane \                                         # Signer config
  --registry gcp://prod-project/override-key \                      # Override for prod
  --origin ethereum \
  --destination polygon
```

## Extracting Keys for External Tools

The `hyperlane registry signer-key` command allows you to extract private keys from supported signer types for use with external tools like Foundry.

### Supported Signer Types

| Type | Extractable | Notes |
|------|-------------|-------|
| `rawKey` | Yes | Returns key from config or env var |
| `gcpSecret` | Yes | Fetches and returns key from GCP Secret Manager |
| `turnkey` | No | Keys in secure enclaves, cannot be exported |
| `foundryKeystore` | No | Use `cast wallet decrypt-keystore` instead |

### Usage

```bash
# Extract the default signer's private key
hyperlane registry signer-key --registry gcp://project/secret

# Get only the address (no private key output)
hyperlane registry signer-key --registry gcp://project/secret --address-only

# Extract a specific named signer
hyperlane registry signer-key --registry ./my-registry --name prod-deployer

# Get the signer for a specific chain
hyperlane registry signer-key --registry ./my-registry --chain ethereum
```

### Using with Foundry

```bash
# Use extracted key with cast
KEY=$(hyperlane registry signer-key --registry gcp://project/secret 2>/dev/null | tail -1)
cast send --private-key "$KEY" 0x... "transfer(address,uint256)" ...

# Use with forge script
forge script MyScript --private-key "$KEY" --broadcast
```

### Using with Other Tools

```bash
# Export as environment variable
export PRIVATE_KEY=$(hyperlane registry signer-key --registry gcp://project/secret 2>/dev/null | tail -1)

# Verify the address
hyperlane registry signer-key --registry gcp://project/secret --address-only
```

## Security Best Practices

1. **Never commit private keys** - Use `privateKeyEnvVar` or external services
2. **Use different signers per environment** - Dev, staging, production
3. **Prefer external key management** - GCP Secret Manager, Turnkey, etc.
4. **Restrict access** - Use IAM policies for GCP secrets
5. **Rotate keys regularly** - Especially for production deployments

## Troubleshooting

### Signer not found

If you see "No signer found for chain", ensure:
- The registry path is correct
- The `signers/` directory exists with YAML files
- The default or chain-specific signer is configured

### GCP authentication errors

```bash
# Authenticate with GCP
gcloud auth application-default login

# Or use service account
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

### Environment variable not set

If using `privateKeyEnvVar`, ensure the variable is exported:

```bash
export MY_PRIVATE_KEY=0x...
```

## API Reference

### SignerConfig Types

```typescript
type SignerType = 'rawKey' | 'turnkey' | 'gcpSecret' | 'foundryKeystore';

interface RawKeySignerConfig {
  type: 'rawKey';
  privateKey?: string;      // Direct key (0x prefixed)
  privateKeyEnvVar?: string; // Env var name
}

interface GCPSecretSignerConfig {
  type: 'gcpSecret';
  project: string;    // GCP project ID
  secretName: string; // Secret name
}

interface TurnkeySignerConfig {
  type: 'turnkey';
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  privateKeyId: string;
  publicKey: string;
  apiBaseUrl?: string;
}

interface FoundryKeystoreSignerConfig {
  type: 'foundryKeystore';
  accountName: string;
  keystorePath?: string;  // Defaults to ~/.foundry/keystores
  passwordFile?: string;  // Path to password file (recommended)
  passwordEnvVar?: string; // Env var with password directly
  // Falls back to ETH_PASSWORD env var (Foundry standard)
}
```

### SignerConfiguration

```typescript
interface SignerConfiguration {
  signers?: Record<string, SignerConfig>;
  defaults?: {
    default?: SignerConfig | { ref: string };
    protocols?: Record<ProtocolType, SignerConfig | { ref: string }>;
    chains?: Record<ChainName, SignerConfig | { ref: string }>;
  };
}
```
