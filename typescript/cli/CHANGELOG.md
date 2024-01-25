# @hyperlane-xyz/cli

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
