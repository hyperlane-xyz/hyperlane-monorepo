---
name: verify-warp-contracts
description: Verify EVM warp route contract source code on block explorers (implementation, ProxyAdmin, TransparentUpgradeableProxy)
---

# Verify Warp Route Contracts

You are a specialized agent for verifying EVM warp route contract source code on block explorers.

## Overview

EVM warp route deployments consist of 3 contracts per chain that all need source verification:

1. **Implementation** — the actual token contract (e.g., HypERC20Collateral)
2. **ProxyAdmin** — OpenZeppelin ProxyAdmin (no constructor args)
3. **TransparentUpgradeableProxy** — the proxy users interact with

## Prerequisites

- `cast` and `forge` CLI tools (from Foundry)
- `pnpm` for installing JS dependencies
- Access to the Hyperlane registry (default: `~/Desktop/hyperlane/hyperlane-registry`)

### Tool versions this skill was written for

| Tool  | Version      | Check command     |
| ----- | ------------ | ----------------- |
| forge | 1.5.0-stable | `forge --version` |
| cast  | 1.5.0-stable | `cast --version`  |

### Step 0: Verify tool compatibility

**Before doing anything else**, check that the installed tool versions are compatible:

```bash
forge --version
cast --version
```

If the major version differs from the table above, verify that the following commands still accept the same arguments by running their `--help`:

1. `forge verify-contract --help` — confirm it still accepts `--verifier`, `--verifier-url`, `--etherscan-api-key`, `--constructor-args`, `--compiler-version`
2. `forge verify-check --help` — confirm it still accepts `--verifier`, `--verifier-url`, `--etherscan-api-key`
3. `cast call --help` — confirm it still accepts `<address> <sig> --rpc-url`
4. `cast storage --help` — confirm it still accepts `<address> <slot> --rpc-url`
5. `cast abi-encode --help` — confirm it still accepts `<sig> <args...>`
6. `cast calldata --help` — confirm it still accepts `<sig> <args...>`
7. `forge soldeer install --help` — confirm it exists and has no required args

If any flag has been renamed or removed, adapt the commands in subsequent steps accordingly. Warn the user about the version mismatch before proceeding.

## Inputs

The user should provide:

- **Warp route config path or ID** — path to the registry YAML config file, or a warp route ID (e.g., "USDC/eclipsemainnet")
- **Chain names** — which chains to verify
- **Registry path** (optional) — path to the local registry checkout

### Resolving the registry and config

Use the following fallback chain to locate the warp route config and chain metadata:

1. **User-provided path** — if the user gave a full file path, use it directly
2. **Local registry checkout** — if the user provided a registry path, or check the default location `~/Desktop/hyperlane/hyperlane-registry`
3. **Local HTTP registry** — check if a local HTTP registry is running at `http://localhost:3333` (default port from `typescript/infra/scripts/http-registry.ts`). If reachable, fetch:
   - Config: `http://localhost:3333/deployments/warp_routes/<token>/<id>-config.yaml`
   - Chain metadata: `http://localhost:3333/chains/<chain>/metadata.yaml`
   - If not running, the user can start it with `/start-http-registry`
4. **GitHub raw** — fetch directly from the public registry repo:
   - Config: `https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/refs/heads/main/deployments/warp_routes/<token>/<id>-config.yaml`
   - Chain metadata: `https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/refs/heads/main/chains/<chain>/metadata.yaml`

If the user provides a warp route ID (e.g., "USDC/eclipsemainnet"), the config path is `deployments/warp_routes/<token>/<id>-config.yaml` relative to the registry root.

## Step-by-Step Workflow

### Step 1: Parse the warp route config

Read the YAML config file. For each requested chain, extract:

- `addressOrDenom` — this is the **proxy** address
- `collateralAddressOrDenom` — the underlying token (for collateral types)
- `standard` — determines which Solidity contract was deployed
- `decimals`

Only `Evm*` standards can be verified with this workflow. Skip non-EVM chains.

### Step 2: Get chain metadata

For each chain, read `<registry>/chains/<chainName>/metadata.yaml` to get:

- `rpcUrls[0].http` — RPC endpoint
- `blockExplorers` — explorer family, apiUrl, and apiKey
- `chainId` — needed for Etherscan V2 API

### Step 3: Query PACKAGE_VERSION

On any one of the target proxy contracts:

```bash
cast call <proxy_address> "PACKAGE_VERSION()(string)" --rpc-url <rpc_url>
```

This returns the `@hyperlane-xyz/core` version (e.g., "11.1.0").

### Step 4: Build Solidity artifacts at the correct version

```bash
# Find the git tag
git rev-parse "@hyperlane-xyz/core@<version>"
```

Check if a worktree already exists at `/tmp/hyp-verify-<version>`. If it does and already has built artifacts (`out/` directory in `solidity/`), reuse it. Otherwise create a new one:

```bash
# Check if worktree already exists
if [ -d /tmp/hyp-verify-<version> ]; then
  echo "Worktree already exists, reusing"
else
  git worktree add /tmp/hyp-verify-<version> "@hyperlane-xyz/core@<version>"
  cd /tmp/hyp-verify-<version> && pnpm install
  cd /tmp/hyp-verify-<version>/solidity && forge soldeer install
  cd /tmp/hyp-verify-<version>/solidity && forge build
fi
```

If the worktree exists but has no `out/` directory, run the install and build steps.

### Step 5: Discover all 3 contract addresses per chain

For each chain:

**Proxy**: already known from config (`addressOrDenom`)

**Implementation**: read EIP-1967 implementation slot:

```bash
cast storage <proxy> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url <rpc>
```

Extract the address from the last 20 bytes of the returned 32-byte value.

**ProxyAdmin**: read EIP-1967 admin slot:

```bash
cast storage <proxy> 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103 --rpc-url <rpc>
```

### Step 6: Build constructor args

#### Implementation constructor args

All token contracts follow a pattern. Query on-chain values through the proxy:

```bash
cast call <proxy> "mailbox()(address)" --rpc-url <rpc>
cast call <proxy> "scaleNumerator()(uint256)" --rpc-url <rpc>
cast call <proxy> "scaleDenominator()(uint256)" --rpc-url <rpc>
```

Then encode based on the contract type:

| Standard               | Contract                  | Constructor Signature                                                                    |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| EvmHypCollateral       | HypERC20Collateral        | `(address erc20, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`     |
| EvmHypSynthetic        | HypERC20                  | `(uint8 decimals, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`    |
| EvmHypNative           | HypNative                 | `(uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`                    |
| EvmHypCollateralFiat   | HypFiatToken              | `(address fiatToken, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)` |
| EvmHypXERC20           | HypXERC20                 | `(address xerc20, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`    |
| EvmHypXERC20Lockbox    | HypXERC20Lockbox          | `(address lockbox, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`   |
| EvmHypRebaseCollateral | HypERC4626Collateral      | `(address vault, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`     |
| EvmHypOwnerCollateral  | HypERC4626OwnerCollateral | `(address vault, uint256 scaleNumerator, uint256 scaleDenominator, address mailbox)`     |

For collateral-like types, the first `address` arg is `collateralAddressOrDenom` from the config.
For `EvmHypSynthetic`, query `decimals()` on the proxy instead.
For `EvmHypNative`, there is no token address arg.

Encode with:

```bash
cast abi-encode "constructor(<types>)" <arg1> <arg2> ...
```

#### ProxyAdmin constructor args

None. ProxyAdmin inherits from Ownable with no explicit constructor args.

#### Proxy constructor args

`TransparentUpgradeableProxy(address _logic, address admin_, bytes memory _data)`

- `_logic` = implementation address (from Step 5)
- `admin_` = ProxyAdmin address (from Step 5)
- `_data` = the `initialize()` calldata used at deployment

The initialize calldata uses selector `0xc0c53b8b` = `initialize(address,address,address)` with args `(address(0), address(0), owner)`.

**IMPORTANT: Deploy-time owner vs current owner.** The owner baked into the `initialize` calldata is the **deploy-time owner** (usually the deployer EOA), NOT the current owner. Ownership may have been transferred post-deployment. You must determine the deploy-time owner, not just call `owner()`.

**Strategy to find the deploy-time owner:**

1. **Try creation bytecode first** — get the proxy's creation bytecode from the explorer API (see below). The constructor args are appended at the tail. Decode the last 32 bytes of the `_data` field to extract the owner address used at deploy time.

2. **Fall back to creation tx sender** — if creation bytecode is unavailable, get the creation transaction:
   - Blockscout: `<apiUrl>?module=contract&action=getcontractcreation&contractaddresses=<address>` → returns `contractCreator` field
   - Etherscan V2: `https://api.etherscan.io/v2/api?chainid=<chainId>&module=contract&action=getcontractcreation&contractaddresses=<address>&apikey=<key>`
   - If both APIs fail (e.g., Etherscan V2 free tier limitation), use the deployer address from the implementation or ProxyAdmin creation info, since all 3 are typically deployed in the same tx or by the same address.

3. **Last resort** — query `owner()` on the proxy, but be aware this may fail verification if ownership was transferred. Always verify against creation bytecode when possible.

Build the init data:

```bash
INIT_DATA=$(cast calldata "initialize(address,address,address)" 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 <deploy_time_owner>)
```

Encode the full constructor args:

```bash
cast abi-encode "constructor(address,address,bytes)" <implementation> <proxyAdmin> "$INIT_DATA"
```

**Verification**: compare the encoded constructor args against the tail of the contract's creation bytecode to make sure they match **before** submitting verification. This is critical — if they don't match, the verification will fail or verify the wrong contract.

Getting creation bytecode:

- Blockscout: `<apiUrl>?module=contract&action=getcontractcreation&contractaddresses=<address>` → `creationBytecode` field
- Etherscan V2: `https://api.etherscan.io/v2/api?chainid=<chainId>&module=contract&action=getcontractcreation&contractaddresses=<address>&apikey=<key>`
- **If explorer APIs fail**: get the creation tx hash from either API's `txHash` field (or find it on the explorer UI), then fetch the full tx input data via RPC:
  ```bash
  cast tx <txHash> input --rpc-url <rpc>
  ```
  The constructor args are the tail of this input data (after the contract init code).

### Step 7: Verify contracts

For each contract, use `forge verify-contract` from the worktree's solidity directory.

#### Blockscout explorers (`family: blockscout`)

```bash
cd /tmp/hyp-verify-<version>/solidity && forge verify-contract \
  <address> \
  <contract_path>:<contract_name> \
  --verifier blockscout \
  --verifier-url <apiUrl> \
  --constructor-args <encoded_args> \
  --compiler-version 0.8.22
```

#### Etherscan explorers (`family: etherscan`)

For Etherscan V2 (standard etherscan-family explorers), use the unified Etherscan V2 API:

```bash
cd /tmp/hyp-verify-<version>/solidity && forge verify-contract \
  <address> \
  <contract_path>:<contract_name> \
  --verifier etherscan \
  --verifier-url "https://api.etherscan.io/v2/api?chainid=<chainId>" \
  --etherscan-api-key <apiKey> \
  --constructor-args <encoded_args> \
  --compiler-version 0.8.22
```

#### Contract paths

| Contract                    | Path                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| HypERC20Collateral          | `contracts/token/HypERC20Collateral.sol:HypERC20Collateral`                                                                          |
| HypERC20                    | `contracts/token/HypERC20.sol:HypERC20`                                                                                              |
| HypNative                   | `contracts/token/HypNative.sol:HypNative`                                                                                            |
| HypFiatToken                | `contracts/token/extensions/HypFiatToken.sol:HypFiatToken`                                                                           |
| HypXERC20                   | `contracts/token/extensions/HypXERC20.sol:HypXERC20`                                                                                 |
| HypXERC20Lockbox            | `contracts/token/extensions/HypXERC20Lockbox.sol:HypXERC20Lockbox`                                                                   |
| HypERC4626Collateral        | `contracts/token/extensions/HypERC4626Collateral.sol:HypERC4626Collateral`                                                           |
| HypERC4626OwnerCollateral   | `contracts/token/extensions/HypERC4626OwnerCollateral.sol:HypERC4626OwnerCollateral`                                                 |
| ProxyAdmin                  | `dependencies/@openzeppelin-contracts-4.9.3/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin`                                   |
| TransparentUpgradeableProxy | `dependencies/@openzeppelin-contracts-4.9.3/contracts/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy` |

#### Verification order

For each chain, verify in this order:

1. Implementation contract
2. ProxyAdmin
3. TransparentUpgradeableProxy

If a contract is already verified, `forge verify-contract` will report "already verified" — this is fine, move on.

After submitting, check verification status if needed:

```bash
forge verify-check <GUID> --verifier <type> --verifier-url <url> [--etherscan-api-key <key>]
```

### Step 8: Report results

After verification, provide the user with explorer links for visual confirmation:

- For each chain and each contract, provide the explorer URL: `<explorer_url>/address/<address>`

### Step 9: Cleanup

Ask the user before removing the worktree:

```bash
git worktree remove /tmp/hyp-verify-<version>
```

## Multiple explorers per chain

Some chains have multiple block explorers (e.g., both Etherscan and Blockscout). If the user requests verification on a specific explorer, use that one. Otherwise verify on all available explorers.

## Troubleshooting

### "Free API access is not supported for this chain"

Etherscan V2 free tier doesn't support all chains for **querying** (e.g., `getcontractcreation`), but **verification submission** still works. For data queries:

- Use RPC calls (`cast storage`, `cast call`) instead of explorer APIs for on-chain data
- To get the creation tx hash or deployer, try the chain's Blockscout explorer if one exists, or check the explorer UI manually
- Use `cast tx <txHash> input --rpc-url <rpc>` to fetch creation bytecode via RPC if you have the tx hash

### Constructor args mismatch

Always verify encoded constructor args against the creation bytecode tail before submitting. If they don't match, re-check:

- The `initialize` function signature — some versions use `initialize(uint32,address,address)` (selector `0x647c576c`) instead of `initialize(address,address,address)` (selector `0xc0c53b8b`). Check the actual creation bytecode to determine which was used.
- Scale values — BSC USDC is 18 decimals but canonical is 6, so `scaleDenominator` may be `1e12`.

### forge soldeer install fails

If soldeer dependencies aren't installing, check if `soldeer.lock` exists in the solidity directory. If not, the version may use a different dependency management approach (e.g., git submodules via `forge install`).

### Compiler version mismatch

Check `foundry.toml` in the worktree's solidity directory for `solc_version`. It's typically `0.8.22` but may differ across versions.

## Your Task

When the user invokes this skill:

1. Ask for the warp route config path and chain names if not provided
2. Execute the workflow above step by step
3. Run verification for all 3 contracts on each chain on each available explorer
4. Report results with explorer links
