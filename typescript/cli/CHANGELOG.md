# @hyperlane-xyz/cli

## 5.1.0

### Minor Changes

- e151b5f9a: Added SDK support for ArbL2ToL1Hook/ISM for selfrelay
- dd12e93e0: Add output of hyperlane warp read to ./configs/warp-route-deployment.yaml
- 7d3b5ceac: Add check & confirm for existing mailbox to core deploy to allow users to decide if they want to deploy a new mailbox

### Patch Changes

- 3d4e6436d: Require at least 1 chain selection in warp init
- Updated dependencies [d408b0d6f]
- Updated dependencies [103e6b3e1]
- Updated dependencies [e151b5f9a]
- Updated dependencies [a49f52cc9]
  - @hyperlane-xyz/sdk@5.1.0
  - @hyperlane-xyz/utils@5.1.0

## 5.0.0

### Major Changes

- f1d70a5e8: refactor: select chain now become 2 step, select mainnet/testnet type first, then select chain

### Minor Changes

- 388d25517: Added HyperlaneRelayer for relaying messages from the CLI
- d0f7f21fd: Fix logging for hyperlane core apply
- d00f2ffc0: Displays formatted deployment plan to confirm warp deploy.
- 40255575c: Adds blockExplorers option on registry init.
- 708999433: Adds hyperlane warp apply
- 0e1a80e6e: Improve chain metadata and address fetching from github registries
- 5529d98d0: Add hyperlane core apply with update ownership
- 62d71fad3: Add hyperlane warp update to extend a warp config
- 49986aa92: Add collateralAddressOrDenom for collateralVault
- ded5718a0: Update hyperlane core read to log the config terminal "preview", only if the number of lines is < 250
- 5125b798d: Prompt for chain testnet/mainnet during chain definition flow
- bb470aec2: Add 'submit' command to CLI.

### Patch Changes

- 80ac5d28e: Display token symbol when balance is insufficient for command
- 6341edf2a: fix: use merkle tree hook address from registry for self relay hook derivations
- c539775d7: Default to mailbox address in registry
- c2a2897d7: Update CLI verbiage to ask for vault and not token when initiating collateralVault warp route.
- Updated dependencies [2c0ae3cf3]
- Updated dependencies [0dedbf5a0]
- Updated dependencies [388d25517]
- Updated dependencies [69a39da1c]
- Updated dependencies [4907b510c]
- Updated dependencies [488f949ef]
- Updated dependencies [c7f5a35e8]
- Updated dependencies [7265a4087]
- Updated dependencies [0a40dcb8b]
- Updated dependencies [f83b492de]
- Updated dependencies [79740755b]
- Updated dependencies [8533f9e66]
- Updated dependencies [ed65556aa]
- Updated dependencies [ab827a3fa]
- Updated dependencies [dfa908796]
- Updated dependencies [ed63e04c4]
- Updated dependencies [dfa908796]
- Updated dependencies [5aa24611b]
- Updated dependencies [cfb890dc6]
- Updated dependencies [708999433]
- Updated dependencies [5529d98d0]
- Updated dependencies [62d71fad3]
- Updated dependencies [49986aa92]
- Updated dependencies [7fdd3958d]
- Updated dependencies [8e942d3c6]
- Updated dependencies [fef629673]
- Updated dependencies [be4617b18]
- Updated dependencies [1474865ae]
  - @hyperlane-xyz/sdk@5.0.0
  - @hyperlane-xyz/utils@5.0.0

## 4.1.0

### Minor Changes

- 4cc9327e5: Update warp deploy to handle xerc20, initializerArgs to be the signer, update deploy gas constants

### Patch Changes

- 46652c62a: Fix the missing sorting in the YAML file generated
- 56be527d6: Fix typo in core read command
- 378a5b79f: Remove extra fields from warp core config
- Updated dependencies [36e75af4e]
- Updated dependencies [d31677224]
- Updated dependencies [4cc9327e5]
- Updated dependencies [1687fca93]
  - @hyperlane-xyz/sdk@4.1.0
  - @hyperlane-xyz/utils@4.1.0

## 4.0.0

### Major Changes

- df6a18053: Release CLI v4.0.0.

### Minor Changes

- 44cc9bf6b: Add CLI command to support AVS validator status check
- b05ae38ac: Gracefully handle RPC failures during warp send & fix deriving hook error that prevents warp and core test messages on the cli.
- 9304fe241: Use metadata builders in message relaying
- 6398aab72: Upgrade registry to 2.1.1
- 5c8ba0b85: Rename hyperlane config create chain -> hyperlane registry init. Rename all `configure` to `init`
- cd419c98a: Add a validator preFlightCheck command verifying that the validator has been announced for a given chain
- 35f869950: Add command to support creating agent configs
- bf7ad09da: feat(cli): add `warp --symbol` flag
- b0828b3d0: Reintroduce `ism read` and `hook read` commands
- 129bd871d: Add chain displayName prompt with default
- 4040db723: Fix createDefaultWarpIsmConfig to default to trusted relayer and fallback routing without prompts
- 6db9fa9ad: Implement hyperlane warp deploy
- bd3ca9195: Updates ci-test.sh to ci-advanced-test.sh.
- b7003cf35: Add stdout.rows to pagesize calculation with DEFAULT_PAGE_SIZE

### Patch Changes

- 3283eefd6: Removes default pattern for chain name when creating a new chain.
- 4dd2651ee: Add xerc20 limit lookups to warp read
- 6b63c5d82: Adds deployment support for IsmConfig within a WarpRouteConfig
- Updated dependencies [b05ae38ac]
- Updated dependencies [9304fe241]
- Updated dependencies [bdcbe1d16]
- Updated dependencies [6b63c5d82]
- Updated dependencies [e38d31685]
- Updated dependencies [e0f226806]
- Updated dependencies [6db9fa9ad]
  - @hyperlane-xyz/sdk@4.0.0
  - @hyperlane-xyz/utils@4.0.0

## 3.16.0

### Patch Changes

- Updated dependencies [f9bbdde76]
- Updated dependencies [5cc64eb09]
  - @hyperlane-xyz/sdk@3.16.0
  - @hyperlane-xyz/utils@3.16.0

## 3.15.1

### Patch Changes

- 921e449b4: Support priorityFee fetching from RPC and some better logging
- Updated dependencies [acaa22cd9]
- Updated dependencies [921e449b4]
  - @hyperlane-xyz/sdk@3.15.1
  - @hyperlane-xyz/utils@3.15.1

## 3.15.0

### Minor Changes

- 51bfff683: Mint/burn limit checking for xERC20 bridging
  Corrects CLI output for HypXERC20 and HypXERC20Lockbox deployments

### Patch Changes

- Updated dependencies [51bfff683]
  - @hyperlane-xyz/sdk@3.15.0
  - @hyperlane-xyz/utils@3.15.0

## 3.14.0

### Minor Changes

- f4bbfcf08: AVS deployment on mainnet

### Patch Changes

- @hyperlane-xyz/sdk@3.14.0
- @hyperlane-xyz/utils@3.14.0

## 3.13.0

### Minor Changes

- b22a0f453: Add hyperlane validator address command to retrieve validator address from AWS
- 39ea7cdef: Implement multi collateral warp routes
- babe816f8: Support xERC20 and xERC20 Lockbox in SDK and CLI
- b440d98be: Added support for registering/deregistering from the Hyperlane AVS

### Patch Changes

- b6b26e2bb: fix: minor change was breaking in registry export
- Updated dependencies [39ea7cdef]
- Updated dependencies [babe816f8]
- Updated dependencies [0cf692e73]
  - @hyperlane-xyz/sdk@3.13.0
  - @hyperlane-xyz/utils@3.13.0

## 3.12.0

### Minor Changes

- cc8731985: Default to home directory for local registry
- ff221f66a: Allows a developer to pass a private key or address to dry-run, and ensures HYP_KEY is only used for private keys.
- eba393680: Add CLI-side submitter to use SDK submitter from CRUD and other command modules.

### Patch Changes

- 2b7dfe27e: Improve defaults in chain config command
- Updated dependencies [eba393680]
- Updated dependencies [69de68a66]
  - @hyperlane-xyz/sdk@3.12.0
  - @hyperlane-xyz/utils@3.12.0

## 3.11.1

### Patch Changes

- 78b77eecf: Fixes for CLI dry-runs
- Updated dependencies [c900da187]
  - @hyperlane-xyz/sdk@3.11.1
  - @hyperlane-xyz/utils@3.11.1

## 3.11.0

### Minor Changes

- f8b6ea467: Update the warp-route-deployment.yaml to a more sensible schema. This schema sets us up to allow multi-chain collateral deployments. Removes intermediary config objects by using zod instead.
- b6fdf2f7f: Implement XERC20 and FiatToken collateral warp routes
- aea79c686: Adds single-chain dry-run support for deploying warp routes & gas estimation for core and warp route dry-run deployments.
- 917266dce: Add --self-relay to CLI commands
- b63714ede: Convert all public hyperlane npm packages from CJS to pure ESM
- 450e8e0d5: Migrate fork util from CLI to SDK. Anvil IP & Port are now optionally passed into fork util by client.
- 3528b281e: Restructure CLI params around registries
- af2634207: Introduces `hyperlane hook read` and `hyperlane ism read` commands for deriving onchain Hook/ISM configs from an address on a given chain.

### Patch Changes

- 8246f14d6: Adds defaultDescription to yargs --key option.
- Updated dependencies [811ecfbba]
- Updated dependencies [f8b6ea467]
- Updated dependencies [d37cbab72]
- Updated dependencies [b6fdf2f7f]
- Updated dependencies [a86a8296b]
- Updated dependencies [2db77f177]
- Updated dependencies [3a08e31b6]
- Updated dependencies [917266dce]
- Updated dependencies [aab63d466]
- Updated dependencies [2e439423e]
- Updated dependencies [b63714ede]
- Updated dependencies [3528b281e]
- Updated dependencies [450e8e0d5]
- Updated dependencies [2b3f75836]
- Updated dependencies [af2634207]
  - @hyperlane-xyz/sdk@3.11.0
  - @hyperlane-xyz/utils@3.11.0

## 3.10.0

### Minor Changes

- 3ec81081c: Breaking: Update the `hyperlane chains list` command to accept an `env` (either 'mainnet' or 'testnet') to list chains for.

  Update `hyperlane chains list` command to pull the set of core chains from the contract addresses constant in the SDK.

- 96485144a: SDK support for ICA deployment and operation.
- 4e7a43be6: Replace Debug logger with Pino

### Patch Changes

- 5373d54ca: Add --log and --verbosity settings to CLI
- Updated dependencies [96485144a]
- Updated dependencies [38358ecec]
- Updated dependencies [ed0d4188c]
- Updated dependencies [4e7a43be6]
  - @hyperlane-xyz/utils@3.10.0
  - @hyperlane-xyz/sdk@3.10.0

## 3.9.0

### Minor Changes

- 11f257ebc: Add Yield Routes to CLI

### Patch Changes

- Updated dependencies [11f257ebc]
  - @hyperlane-xyz/sdk@3.9.0
  - @hyperlane-xyz/utils@3.9.0

## 3.8.2

### Patch Changes

- bfc2b792b: Fix bug with HypCollateral warp route deployments
  - @hyperlane-xyz/sdk@3.8.2
  - @hyperlane-xyz/utils@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [5daaae274]
  - @hyperlane-xyz/utils@3.8.1
  - @hyperlane-xyz/sdk@3.8.1

## 3.8.0

### Patch Changes

- 9681df08d: TestRecipient as part of core deployer
- 9681df08d: Update CLI Warp route deployment output shape to new WarpCore config
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
  - @hyperlane-xyz/sdk@3.8.0
  - @hyperlane-xyz/utils@3.8.0

## 3.7.0

### Minor Changes

- 84e508039: Improve send transfer ergonomics by omitting token type flag
- 7ff826a8f: Merged agent addresses will now include igp as the zero address if not configured as the hook

### Patch Changes

- ab17af5f7: Updating HyperlaneIgpDeployer to configure storage gas oracles as part of deployment
- Updated dependencies [6f464eaed]
- Updated dependencies [87151c62b]
- Updated dependencies [ab17af5f7]
- Updated dependencies [7b40232af]
- Updated dependencies [54aeb6420]
  - @hyperlane-xyz/sdk@3.7.0
  - @hyperlane-xyz/utils@3.7.0

## 3.6.2

### Patch Changes

- 99fe93a5b: Removed IGP from preset hook config
  - @hyperlane-xyz/sdk@3.6.2
  - @hyperlane-xyz/utils@3.6.2

## 3.6.1

### Patch Changes

- Updated dependencies [3c298d064]
- Updated dependencies [ae4476ad0]
- Updated dependencies [f3b7ddb69]
- Updated dependencies [df24eec8b]
- Updated dependencies [78e50e7da]
- Updated dependencies [e4e4f93fc]
  - @hyperlane-xyz/utils@3.6.1
  - @hyperlane-xyz/sdk@3.6.1

## 3.6.0

### Patch Changes

- 67a6d971e: Added `shouldRecover` flag to deployContractFromFactory so that the `TestRecipientDeployer` can deploy new contracts if it's not the owner of the prior deployments (We were recovering the SDK artifacts which meant the deployer won't be able to set the ISM as they needed)
- Updated dependencies [67a6d971e]
- Updated dependencies [612d4163a]
- Updated dependencies [0488ef31d]
- Updated dependencies [8d8ba3f7a]
  - @hyperlane-xyz/sdk@3.6.0
  - @hyperlane-xyz/utils@3.6.0

## 3.5.1

### Patch Changes

- Updated dependencies [a04454d6d]
  - @hyperlane-xyz/sdk@3.5.1
  - @hyperlane-xyz/utils@3.5.1

## 3.5.0

### Patch Changes

- 05a943b4a: Skip mandatory balance check for remotes in send commands"
- Updated dependencies [655b6a0cd]
- Updated dependencies [08ba0d32b]
- Updated dependencies [f7d285e3a]
  - @hyperlane-xyz/sdk@3.5.0
  - @hyperlane-xyz/utils@3.5.0

## 3.4.0

### Patch Changes

- e06fe0b32: Supporting DefaultFallbackRoutingIsm through non-factory deployments
- dcf8b800a: Fixes for commands with --yes flag
- 9c7dbcb94: Remove domainId and protocolType setting when creating chain config
- Updated dependencies [7919417ec]
- Updated dependencies [fd4fc1898]
- Updated dependencies [e06fe0b32]
- Updated dependencies [b832e57ae]
- Updated dependencies [79c96d718]
  - @hyperlane-xyz/sdk@3.4.0
  - @hyperlane-xyz/utils@3.4.0

## 3.3.0

### Minor Changes

- 7e620c9df: Allow CLI to accept hook as a config

### Patch Changes

- f44589e45: Improve warp and kurtosis deploy command UX
- 2da6ccebe: Allow users to only configure validators for their chain

  - Don't restrict user to having two chains for ism config
  - If the user accidentally picks two chains, we prompt them again to confirm if they don't want to use the hyperlane validators for their multisigConfig

- 9f2c7ce7c: Removing agentStartBlocks and using mailbox.deployedBlock() instead
- 9705079f9: Improve UX of the send and status commands
- c606b6a48: Add figlet to CLI
- Updated dependencies [7e620c9df]
- Updated dependencies [350175581]
- Updated dependencies [9f2c7ce7c]
  - @hyperlane-xyz/sdk@3.3.0
  - @hyperlane-xyz/utils@3.3.0

## 3.2.0

### Minor Changes

- df693708b: Add support for all ISM types in CLI interactive config creation

### Patch Changes

- 433c5aadb: Fix error form version command
- Updated dependencies [df693708b]
  - @hyperlane-xyz/sdk@3.2.0
  - @hyperlane-xyz/utils@3.2.0

## 3.1.10

### Patch Changes

- 97f4c9421: Various user experience improvements
  - @hyperlane-xyz/sdk@3.1.10
  - @hyperlane-xyz/utils@3.1.10
