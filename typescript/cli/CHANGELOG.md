# @hyperlane-xyz/cli

## 13.0.0-starknet.1

## 12.4.0

## 12.3.0

### Minor Changes

- 5db39f493: Fixes to support CosmosNative and warp apply with foreign deployments.

## 12.2.0

## 12.1.0

### Patch Changes

- Updated dependencies [acbf5936a]
- Updated dependencies [c757b6a18]
- Updated dependencies [a646f9ca1]
- Updated dependencies [3b615c892]
  - @hyperlane-xyz/sdk@12.1.0
  - @hyperlane-xyz/utils@12.1.0

## 12.0.0

### Minor Changes

- 82166916a: feat: support github auth token for authenticated registries

### Patch Changes

- Updated dependencies [f7ca32315]
- Updated dependencies [4d3738d14]
- Updated dependencies [07321f6f0]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [337193305]
  - @hyperlane-xyz/sdk@12.0.0
  - @hyperlane-xyz/utils@12.0.0

## 11.0.0

### Patch Changes

- Updated dependencies [888d180b6]
- Updated dependencies [3b060c3e1]
  - @hyperlane-xyz/sdk@11.0.0
  - @hyperlane-xyz/utils@11.0.0

## 10.0.0

### Patch Changes

- Updated dependencies [7dbf7e4fa]
- Updated dependencies [b8d95fc95]
- Updated dependencies [28ca87293]
- Updated dependencies [4fd5623b8]
  - @hyperlane-xyz/sdk@10.0.0
  - @hyperlane-xyz/utils@10.0.0

## 9.2.1

### Patch Changes

- Updated dependencies [e3d09168e]
  - @hyperlane-xyz/sdk@9.2.1
  - @hyperlane-xyz/utils@9.2.1

## 9.2.0

### Patch Changes

- 2955bd990: Catch and log error instead of hard exiting when unable to get the tx receipt of a delivered message.
- 53dd71a4b: Do not error in hyperlane status if chain does not contain block explorer URL.
- Updated dependencies [7fe739d52]
- Updated dependencies [3e66e8f12]
- Updated dependencies [3852a9015]
  - @hyperlane-xyz/sdk@9.2.0
  - @hyperlane-xyz/utils@9.2.0

## 9.1.0

### Minor Changes

- cad82683f: Extracted ISM and Hook factory addresses into a reusable utility function to reduce repetition and improve maintainability.
- cad82683f: Improved warp route extension and configuration handling

### Patch Changes

- 9f9e2c3b5: fix `warp check` command to correctly check the remote routers in the config
- Updated dependencies [67d91e489]
- Updated dependencies [cad82683f]
- Updated dependencies [97c773476]
- Updated dependencies [351bf0010]
- Updated dependencies [cad82683f]
  - @hyperlane-xyz/sdk@9.1.0
  - @hyperlane-xyz/utils@9.1.0

## 9.0.0

### Minor Changes

- 0d8624d99: Make mailbox optional on warp deploy config

### Patch Changes

- Updated dependencies [0d8624d99]
- Updated dependencies [b07e2f2ea]
- Updated dependencies [4df37393f]
- Updated dependencies [88970a78c]
  - @hyperlane-xyz/sdk@9.0.0
  - @hyperlane-xyz/utils@9.0.0

## 8.9.0

### Minor Changes

- 05f89650b: Added utils for fetching extra lockboxes data from a xERC20 warp route
- d121c1cb8: Add XERC20 derivation in SDK/CLI Warp Reading
- d6ddf5b9e: make warp:read and warp:check/warp:verify operations independent of signer requirements
- 766f50695: Change semantics of ism/hook config from undefined to 0x0 for reading/checking purposes
- 1955579cf: Expand warpDeployConfig for checking purposes
- 33178eaa8: Move getRegistry function from the CLI to `@hyperlane-xyz/registry` package.
- 4147f91cb: Added support for the new AmountRoutingIsm to be deployed and managed by the cli
- 500249649: Enable usage of CCIP Hooks and ISMs in warp routes.
- 03266e2c2: add amount routing hook support in the sdk and cli

### Patch Changes

- 9fd3aa4f3: Correctly await address in native balance check.
- a835d5c5c: Only relay specified message ID
- Updated dependencies [05f89650b]
- Updated dependencies [d121c1cb8]
- Updated dependencies [3518f8901]
- Updated dependencies [d6ddf5b9e]
- Updated dependencies [766f50695]
- Updated dependencies [e78060d73]
- Updated dependencies [cb7c157f0]
- Updated dependencies [ede0cbc15]
- Updated dependencies [1955579cf]
- Updated dependencies [57137dad4]
- Updated dependencies [3518f8901]
- Updated dependencies [500249649]
- Updated dependencies [03266e2c2]
- Updated dependencies [cb93c13a4]
- Updated dependencies [456407dc7]
- Updated dependencies [4147f91cb]
  - @hyperlane-xyz/utils@8.9.0
  - @hyperlane-xyz/sdk@8.9.0

## 8.8.1

### Patch Changes

- c68529807: Update registry dependency.
  - @hyperlane-xyz/sdk@8.8.1
  - @hyperlane-xyz/utils@8.8.1

## 8.8.0

### Minor Changes

- d82d24cc7: Update `hyperlane warp init` to be undefined for ISM by default.
- b054b0424: Update `hyperlane warp init` to not output proxyAdmin by default.

### Patch Changes

- Updated dependencies [719d022ec]
- Updated dependencies [c61546cb7]
  - @hyperlane-xyz/sdk@8.8.0
  - @hyperlane-xyz/utils@8.8.0

## 8.7.0

### Minor Changes

- db832b803: Added support for multiple registries in CLI with prioritization.
- 7dd1f64a6: Update submitWarpApplyTransactions() to try-catch and print safe errors

### Patch Changes

- Updated dependencies [bd0b8861f]
- Updated dependencies [55db270e3]
- Updated dependencies [b92eb1b57]
- Updated dependencies [ede0cbc15]
- Updated dependencies [12e3c4da0]
- Updated dependencies [d6724c4c3]
- Updated dependencies [d93a38cab]
  - @hyperlane-xyz/sdk@8.7.0
  - @hyperlane-xyz/utils@8.7.0

## 8.6.1

### Patch Changes

- 236f27b5f: Fix cli package dependencies.
  - @hyperlane-xyz/sdk@8.6.1
  - @hyperlane-xyz/utils@8.6.1

## 8.6.0

### Minor Changes

- d2bc2cfec: Update CLI package.json to be able to export functions

### Patch Changes

- 1e6ee0b9c: Fix default multichain strategy resolving.
- Updated dependencies [407d82004]
- Updated dependencies [ac984a17b]
- Updated dependencies [276d7ce4e]
- Updated dependencies [ba50e62fc]
- Updated dependencies [1e6ee0b9c]
- Updated dependencies [77946bb13]
  - @hyperlane-xyz/sdk@8.6.0
  - @hyperlane-xyz/utils@8.6.0

## 8.5.0

### Patch Changes

- Updated dependencies [55b8ccdff]
  - @hyperlane-xyz/sdk@8.5.0
  - @hyperlane-xyz/utils@8.5.0

## 8.4.0

### Patch Changes

- Updated dependencies [f6b682cdb]
  - @hyperlane-xyz/sdk@8.4.0
  - @hyperlane-xyz/utils@8.4.0

## 8.3.0

### Minor Changes

- 228f7c3d1: Fix issue where warp deploy artifacts did not include correct symbols.

### Patch Changes

- Updated dependencies [7546c0181]
- Updated dependencies [49856fbb9]
  - @hyperlane-xyz/sdk@8.3.0
  - @hyperlane-xyz/utils@8.3.0

## 8.2.0

### Minor Changes

- 9eb19cac7: Add explorer link to warp send and send message commands
- aad2c2d1e: Fixing the chain resolver checks and handling for argv.chain

### Patch Changes

- 1536ea570: Print displayName instead of chain name in signer validity logs.
- Updated dependencies [69a684869]
  - @hyperlane-xyz/sdk@8.2.0
  - @hyperlane-xyz/utils@8.2.0

## 8.1.0

### Minor Changes

- 2d018fa7a: Fix hyperlane warp send where --origin and --destination are out of order

### Patch Changes

- Updated dependencies [79c61c891]
- Updated dependencies [9518dbc84]
- Updated dependencies [9ab961a79]
  - @hyperlane-xyz/sdk@8.1.0
  - @hyperlane-xyz/utils@8.1.0

## 8.0.0

### Minor Changes

- fd20bb1e9: Add FeeHook and Swell to pz and ez eth config generator. Bump up Registry 6.6.0
- bb44f9b51: Add support for deploying Hooks using a HookConfig within a WarpConfig
- c2ca8490d: fix signer strategy init for broken cli commands
- 9f6b8c514: Allow self-relaying of all messages if there are multiple in a given dispatch transaction.
- 3c4bc1cca: Update hyperlane warp send to send a round trip transfer to all chains in WarpCoreConfig, if --origin and/or --destination is not provided.
- 79f8197f3: Added strategy management CLI commands and MultiProtocolSigner implementation for flexible cross-chain signer configuration and management
- a5ece3b30: Add chain technical stack selector with Arbitrum Nitro support to `hyperlane registry init` command
- d35502fa7: Update single chain selection to be searchable instead of a simple select

### Patch Changes

- 472b34670: Bump registry version to v6.3.0.
- 0c8372447: fix: balance check skip confirmation
- 657ac9255: Suppress help on CLI failures
- 9349ef73e: Fix strategy flag propagation
- cd7c41308: Fix yaml resource exhaustion
- 98ee79c17: Added ZKSync signer support using zksync-ethers package
- Updated dependencies [472b34670]
- Updated dependencies [79f8197f3]
- Updated dependencies [fd20bb1e9]
- Updated dependencies [26fbec8f6]
- Updated dependencies [71aefa03e]
- Updated dependencies [9f6b8c514]
- Updated dependencies [82cebabe4]
- Updated dependencies [95cc9571e]
- Updated dependencies [c690ca82f]
- Updated dependencies [5942e9cff]
- Updated dependencies [de1190656]
- Updated dependencies [e9911bb9d]
- Updated dependencies [8834a8c92]
  - @hyperlane-xyz/sdk@8.0.0
  - @hyperlane-xyz/utils@8.0.0

## 7.3.0

### Minor Changes

- aa1ea9a48: updates the warp deployment config schema to be closer to the ica routing schema
- 323f0f158: Add ICAs management in core apply command

### Patch Changes

- 455a897fb: Fix a bug where it would try to relay the incorrect message from a transaction that dispatches multiple messages.
- Updated dependencies [2054f4f5b]
- Updated dependencies [a96448fa6]
- Updated dependencies [170a0fc73]
- Updated dependencies [9a09afcc7]
- Updated dependencies [24784af95]
- Updated dependencies [3e8dd70ac]
- Updated dependencies [aa1ea9a48]
- Updated dependencies [665a7b8d8]
- Updated dependencies [f0b98fdef]
- Updated dependencies [ff9e8a72b]
- Updated dependencies [97c1f80b7]
- Updated dependencies [323f0f158]
- Updated dependencies [61157097b]
  - @hyperlane-xyz/sdk@7.3.0
  - @hyperlane-xyz/utils@7.3.0

## 7.2.0

### Minor Changes

- d51815760: Support using the CLI to deploy warp routes that involve foreign deployments
- 81ab4332f: Remove ismFactoryAddresses from warpConfig
- 4b3537470: Changed the type of defaultMultisigConfigs, to track validator aliases in addition to their addresses.

### Patch Changes

- Updated dependencies [81ab4332f]
- Updated dependencies [4b3537470]
- Updated dependencies [fa6d5f5c6]
- Updated dependencies [fa6d5f5c6]
  - @hyperlane-xyz/sdk@7.2.0
  - @hyperlane-xyz/utils@7.2.0

## 7.1.0

### Minor Changes

- 5db46bd31: Implements persistent relayer for use in CLI

### Patch Changes

- Updated dependencies [6f2d50fbd]
- Updated dependencies [1159e0f4b]
- Updated dependencies [0e285a443]
- Updated dependencies [ff2b4e2fb]
- Updated dependencies [0e285a443]
- Updated dependencies [5db46bd31]
- Updated dependencies [0cd65c571]
  - @hyperlane-xyz/sdk@7.1.0
  - @hyperlane-xyz/utils@7.1.0

## 7.0.0

### Minor Changes

- fa424826c: Add support for updating the mailbox proxy admin owner
- 836060240: Add storage based multisig ISM types

### Patch Changes

- Updated dependencies [bbb970a44]
- Updated dependencies [fa424826c]
- Updated dependencies [f48cf8766]
- Updated dependencies [40d59a2f4]
- Updated dependencies [0264f709e]
- Updated dependencies [836060240]
- Updated dependencies [ba0122279]
- Updated dependencies [e6f9d5c4f]
- Updated dependencies [f24835438]
- Updated dependencies [5f41b1134]
  - @hyperlane-xyz/sdk@7.0.0
  - @hyperlane-xyz/utils@7.0.0

## 6.0.0

### Major Changes

- e3b97c455: Detangle assumption that chainId == domainId for EVM chains. Domain IDs and Chain Names are still unique, but chainId is no longer guaranteed to be a unique identifier. Domain ID is no longer an optional field and is now required for all chain metadata.

### Patch Changes

- Updated dependencies [7b3b07900]
- Updated dependencies [30d92c319]
- Updated dependencies [e3b97c455]
  - @hyperlane-xyz/sdk@6.0.0
  - @hyperlane-xyz/utils@6.0.0

## 5.7.0

### Minor Changes

- db0e73502: re-enable space key for multiselect cli prompt
- 7e9e248be: Add feat to allow updates to destination gas using warp apply
- 4c0605dca: Add optional proxy admin reuse in warp route deployments and admin proxy ownership transfer in warp apply
- db5875cc2: Add `hyperlane warp verify` to allow post-deployment verification.
- 956ff752a: Enable configuration of IGP hooks in the CLI

### Patch Changes

- Updated dependencies [5dabdf388]
- Updated dependencies [469f2f340]
- Updated dependencies [e104cf6aa]
- Updated dependencies [d9505ab58]
- Updated dependencies [04108155d]
- Updated dependencies [7e9e248be]
- Updated dependencies [4c0605dca]
- Updated dependencies [db9196837]
- Updated dependencies [db5875cc2]
- Updated dependencies [56328e6e1]
- Updated dependencies [956ff752a]
- Updated dependencies [39a9b2038]
  - @hyperlane-xyz/sdk@5.7.0
  - @hyperlane-xyz/utils@5.7.0

## 5.6.2

### Patch Changes

- Updated dependencies [5fd4267e7]
- Updated dependencies [a36fc5fb2]
  - @hyperlane-xyz/utils@5.6.2
  - @hyperlane-xyz/sdk@5.6.2

## 5.6.1

### Patch Changes

- 3474a8450: Explicitly define inquirer/core and inquirier/figures dependencies
  - @hyperlane-xyz/sdk@5.6.1
  - @hyperlane-xyz/utils@5.6.1

## 5.6.0

### Minor Changes

- 41035aac8: Add strategyUrl detect and validation in the beginning of `warp apply`
  Remove yaml transactions print from `warp apply`
- 29341950e: Adds new `core check` command to compare local configuration and on chain deployments. Adds memoization to the EvmHookReader to avoid repeating configuration derivation
- 32d0a67c2: Adds the warp check command to compare warp routes config files with on chain warp route deployments
- 3662297fc: Add prompt in `warp init` command to choose if a trusted relayer should be used instead of making the choice by default for the user and enable the `--yes` flag to default to a trusted ISM
- b1ff48bd1: Add rebasing yield route support into CLI/SDK
- d41aa6928: Add `EthJsonRpcBlockParameterTag` enum for validating reorgPeriod
- c3e9268f1: Add support for an arbitrary string in `reorgPeriod`, which is used as a block tag to get the finalized block.
- a4d5d692f: Update `warp apply` such that it updates in place AND extends in a single call
- 01e7070eb: updates the multi chain selection prompt by adding search functionality and an optional confirmation prompt for the current selection

### Patch Changes

- e89f9e35d: Update registry to v4.7.0
- Updated dependencies [f1712deb7]
- Updated dependencies [46044a2e9]
- Updated dependencies [02a5b92ba]
- Updated dependencies [29341950e]
- Updated dependencies [8001bbbd6]
- Updated dependencies [32d0a67c2]
- Updated dependencies [b1ff48bd1]
- Updated dependencies [d41aa6928]
- Updated dependencies [c3e9268f1]
- Updated dependencies [7d7bcc1a3]
- Updated dependencies [7f3e0669d]
- Updated dependencies [2317eca3c]
  - @hyperlane-xyz/utils@5.6.0
  - @hyperlane-xyz/sdk@5.6.0

## 5.5.0

### Patch Changes

- fcfe91113: Reuse SDK transaction typings in tx submitters
- Updated dependencies [2afc484a2]
- Updated dependencies [2afc484a2]
- Updated dependencies [3254472e0]
- Updated dependencies [fcfe91113]
- Updated dependencies [6176c9861]
  - @hyperlane-xyz/sdk@5.5.0
  - @hyperlane-xyz/utils@5.5.0

## 5.4.0

### Minor Changes

- 4415ac224: Add Gnosis safe transaction builder to warp apply

### Patch Changes

- Updated dependencies [4415ac224]
  - @hyperlane-xyz/utils@5.4.0
  - @hyperlane-xyz/sdk@5.4.0

## 5.3.0

### Minor Changes

- 35d4503b9: Update to registry v4.3.6
- aef3dbf4d: Remove mailbox choice prompt if it can be automatically detected from the registry

### Patch Changes

- a513e1b51: Override default with merkle hook for self relay
- Updated dependencies [eb47aaee8]
- Updated dependencies [50319d8ba]
- Updated dependencies [8de531fa4]
- Updated dependencies [746eeb9d9]
- Updated dependencies [fd536a79a]
- Updated dependencies [50319d8ba]
  - @hyperlane-xyz/sdk@5.3.0
  - @hyperlane-xyz/utils@5.3.0

## 5.2.1

### Patch Changes

- @hyperlane-xyz/sdk@5.2.1
- @hyperlane-xyz/utils@5.2.1

## 5.2.0

### Minor Changes

- a5afd20f3: Add CLI e2e typescript tests
- 203084df2: Added sdk support for Stake weighted ISM
- a46fe434a: Add hyperlane registry rpc and addresses --contract utils
- f2783c03b: Add ChainSubmissionStrategySchema
- 3c07ded5b: Add Safe submit functionality to warp apply

### Patch Changes

- Updated dependencies [a19e882fd]
- Updated dependencies [d6de34ad5]
- Updated dependencies [518a1bef9]
- Updated dependencies [203084df2]
- Updated dependencies [74a592e58]
- Updated dependencies [739af9a34]
- Updated dependencies [44588c31d]
- Updated dependencies [2bd540e0f]
- Updated dependencies [291c5fe36]
- Updated dependencies [69f17d99a]
- Updated dependencies [3ad5918da]
- Updated dependencies [291c5fe36]
- Updated dependencies [9563a8beb]
- Updated dependencies [73c232b3a]
- Updated dependencies [445b6222c]
- Updated dependencies [d6de34ad5]
- Updated dependencies [2e6176f67]
- Updated dependencies [f2783c03b]
- Updated dependencies [2ffb78f5c]
- Updated dependencies [3c07ded5b]
- Updated dependencies [815542dd7]
  - @hyperlane-xyz/sdk@5.2.0
  - @hyperlane-xyz/utils@5.2.0

## 5.1.0

### Minor Changes

- 013f19c64: Update to registry v2.5.0
- 013f19c64: Added SDK support for ArbL2ToL1Hook/ISM for selfrelay
- 013f19c64: Add output of hyperlane warp read to ./configs/warp-route-deployment.yaml
- 013f19c64: Remove registry.getUri() from core read logging to prevent registry error
- 013f19c64: Fixes the new chain message to display the correct command
- 013f19c64: Add check & confirm for existing mailbox to core deploy to allow users to decide if they want to deploy a new mailbox

### Patch Changes

- 013f19c64: Require at least 1 chain selection in warp init
- 013f19c64: feat: Add long-running CLI relayer
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [19f7d4fd9]
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
