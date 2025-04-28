# @hyperlane-xyz/sdk

## 12.3.0

### Minor Changes

- 6101959f7: Enhanced the router enrollment check to support non-fully connected warp routes using the `remoteRouters` property from the deployment config.
- 5db39f493: Fixes to support CosmosNative and warp apply with foreign deployments.
- 7500bd6fe: implemented cosmos protocol type and cosmos token adapter

### Patch Changes

- Updated dependencies [7500bd6fe]
  - @hyperlane-xyz/utils@12.3.0
  - @hyperlane-xyz/core@7.1.2
  - @hyperlane-xyz/cosmos-sdk@12.3.0

## 12.2.0

### Minor Changes

- c7934f711: Adds the isRevokeApprovalRequired method on the token adapters to check if the user should revoke any previously set allowances on the token to transfer to avoid approvals failing like in the case of USDT
- ecbacbdf2: Add EvmHypRebaseCollateralAdapter and EvmHypSyntheticRebaseAdapter

### Patch Changes

- @hyperlane-xyz/utils@12.2.0
- @hyperlane-xyz/core@7.1.1

## 12.1.0

### Minor Changes

- acbf5936a: New check: HyperlaneRouterChecker now compares the list of domains
  the Router is enrolled with against the warp route expectations.
  It will raise a violation for missing remote domains.
  `check-deploy` and `check-warp-deploy` scripts use this new check.
- c757b6a18: Include entire RPC array for chainMetadataToViemChain
- a646f9ca1: Added ZKSync specific deployment logic and artifact related utils
- 3b615c892: Adds the proxyAdmin.owner to the Checker ownerOverrides such that it checks proxyAdmin.owner instead of always using the top-level owner

### Patch Changes

- Updated dependencies [e6f6d61a0]
  - @hyperlane-xyz/core@7.1.0
  - @hyperlane-xyz/utils@12.1.0

## 12.0.0

### Major Changes

- 59a087ded: Remove unused FastTokenRouter

### Minor Changes

- 4d3738d14: Update Checker to only check collateralToken and collateralProxyAdmin if provided in ownerOverrides
- 07321f6f0: ZKSync Provider types with builders
- 337193305: Add new `public` field to RpcUrlSchema

### Patch Changes

- f7ca32315: fix: correct exported TypeScript types for synthetic tokens
- 59a087ded: Deploy new scaled warp route bytecode
- Updated dependencies [07321f6f0]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
  - @hyperlane-xyz/core@7.0.0
  - @hyperlane-xyz/utils@12.0.0

## 11.0.0

### Major Changes

- 3b060c3e1: Stub new CosmosModule ProtocolType.

### Minor Changes

- 888d180b6: Fixes a small bug when initializing a token adapter that caused the wrong adapter to be chosen when interacting with svm chains + add new warp ids for new soon wr deployments

### Patch Changes

- Updated dependencies [cd0424595]
- Updated dependencies [3b060c3e1]
  - @hyperlane-xyz/core@6.1.0
  - @hyperlane-xyz/utils@11.0.0

## 10.0.0

### Major Changes

- 4fd5623b8: Fixes a bug where `SealevelHypCollateralAdapter` initialization logic erroneously set the `isSpl2022` property to false.

  It updates the `Token.getHypAdapter` and `Token.getAdapter` methods to be async so that before creating an instance of the `SealevelHypCollateralAdapter` class, the collateral account info can be retrieved on chain to set the correct spl standard.

### Minor Changes

- 7dbf7e4fa: Deploy to cotitestnet, plumetestnet2, modetestnet.
- 28ca87293: Deploy to coti, deepbrainchain, nibiru, opbnb, reactive.

### Patch Changes

- Updated dependencies [b8d95fc95]
- Updated dependencies [fff9cbf57]
  - @hyperlane-xyz/utils@10.0.0
  - @hyperlane-xyz/core@6.0.4

## 9.2.1

### Patch Changes

- e3d09168e: Updated NON_ZERO_SENDER_ADDRESS to 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 to fix reading on zksync chains
  - @hyperlane-xyz/utils@9.2.1
  - @hyperlane-xyz/core@6.0.3

## 9.2.0

### Minor Changes

- 7fe739d52: Update default ISMs with new validators for infinityvm, plume, fuse. Add gas buffer when deploying Interchain Accounts. Add gas buffer when transferring ownership of contracts in HyperlaneDeployer. Migrate safe signing from signTransactionHash -> signTypedData.
- 3e66e8f12: Utils for fetching Starknet chains
- 4f08670d8: Remove totalSupply from TokenMetadata and introduce initialSupply for synthetic warp routes

### Patch Changes

- 3852a9015: Fix WarpCore collateral check for lockboxes
  - @hyperlane-xyz/utils@9.2.0
  - @hyperlane-xyz/core@6.0.2

## 9.1.0

### Minor Changes

- 67d91e489: Constraint Max Mint Limit limit for super XERC20, separate check for limit and destination collateral and new lockbox token in TOKEN_COLLATERALIZED_STANDARDS
- cad82683f: Extracted ISM and Hook factory addresses into a reusable utility function to reduce repetition and improve maintainability.
- 351bf0010: Support populateClaimTx on SealevelIgpAdapter
- cad82683f: Improved warp route extension and configuration handling

### Patch Changes

- 97c773476: Skip non-Ethereum chains when deriving token metadata
  - @hyperlane-xyz/utils@9.1.0
  - @hyperlane-xyz/core@6.0.1

## 9.0.0

### Major Changes

- 4df37393f: Added minimal support for Starknet networks (for successful registry build)

### Minor Changes

- 0d8624d99: Make mailbox optional on warp deploy config
- b07e2f2ea: Estimate gas + add buffer on mailbox initialization, setting ISMs, setting IGP configs, setting routing hooks.

### Patch Changes

- 88970a78c: Deploy new scaled warp route bytecode
- Updated dependencies [88970a78c]
- Updated dependencies [88970a78c]
- Updated dependencies [4df37393f]
- Updated dependencies [88970a78c]
  - @hyperlane-xyz/core@6.0.0
  - @hyperlane-xyz/utils@9.0.0

## 8.9.0

### Minor Changes

- 05f89650b: Added utils for fetching extra lockboxes data from a xERC20 warp route
- d121c1cb8: Add XERC20 derivation in SDK/CLI Warp Reading
- 3518f8901: Implement HyperlaneCCIPDeployer and CCIPContractCache, for deploying and initializing CCIP ISMs/Hooks for supported pairs of CCIP chains.
- d6ddf5b9e: make warp:read and warp:check/warp:verify operations independent of signer requirements
- 766f50695: Change semantics of ism/hook config from undefined to 0x0 for reading/checking purposes
- e78060d73: Add CCIP boiler plate for existing ISM and Hook deployers.
- cb7c157f0: Support DefaultHook in the SDK.
- ede0cbc15: Don't derive testnet domains in IGP config derivation on mainnet
- 1955579cf: Expand warpDeployConfig for checking purposes
- 57137dad4: Add consts and utils for integrating with CCIP.
- 500249649: Enable usage of CCIP Hooks and ISMs in warp routes.
- 03266e2c2: add amount routing hook support in the sdk and cli
- cb93c13a4: Add EvmHypVSXERC20LockboxAdapter and EvmHypVSXERC20Adapter adapters
- 4147f91cb: Added AmountRoutingIsm support to the IsmReader and Factory

### Patch Changes

- 456407dc7: Adds checking to warp route collateral contracts
- Updated dependencies [1a0eba65b]
- Updated dependencies [05f89650b]
- Updated dependencies [9a010dfc1]
- Updated dependencies [1a0eba65b]
- Updated dependencies [f3c67a214]
- Updated dependencies [3518f8901]
- Updated dependencies [03266e2c2]
- Updated dependencies [27eadbfc3]
- Updated dependencies [4147f91cb]
  - @hyperlane-xyz/core@5.12.0
  - @hyperlane-xyz/utils@8.9.0

## 8.8.1

### Patch Changes

- @hyperlane-xyz/utils@8.8.1
- @hyperlane-xyz/core@5.11.6

## 8.8.0

### Minor Changes

- 719d022ec: Add availability field to Chain Metadata
- c61546cb7: Remove priority fee for sealevel non-solana chains

### Patch Changes

- @hyperlane-xyz/utils@8.8.0
- @hyperlane-xyz/core@5.11.5

## 8.7.0

### Minor Changes

- bd0b8861f: Deploy to hyperevm.
- 55db270e3: Deploy to chains bouncebit, arcadia, ronin, sophon, story, subtensor.
- b92eb1b57: Deploy to subtensortestnet.
- ede0cbc15: Don't derive testnet domains in IGP config derivation on mainnet
- 12e3c4da0: Enroll new validators for unichain, celo, base, mantle, worldchain, bouncebit, arcadia, ronin, sophon, story, subtensor, hyperevm.
- d6724c4c3: Fix an issue with HookModule that causes HookModule trigger triggering a new deployment due to unnormalized config despite configs being the same
- d93a38cab: Add MissingRouterViolation when config misses enrolled routers

### Patch Changes

- @hyperlane-xyz/utils@8.7.0
- @hyperlane-xyz/core@5.11.4

## 8.6.1

### Patch Changes

- @hyperlane-xyz/utils@8.6.1
- @hyperlane-xyz/core@5.11.3

## 8.6.0

### Minor Changes

- 407d82004: Enroll new validators for glue, matchain, unitzero, abstract, sonicsvm, injective, swell.
- 276d7ce4e: Deploy to berachain.
- 1e6ee0b9c: Add new validators for unichain and berachain.
- 77946bb13: Deploy to chronicleyellowstone testnet.

### Patch Changes

- ac984a17b: Fix contract address filtering to remove undefined factory addresses from the addresses map
- ba50e62fc: Added ESLint configuration and dependency to enforce Node.js module restrictions
- Updated dependencies [ba50e62fc]
  - @hyperlane-xyz/core@5.11.2
  - @hyperlane-xyz/utils@8.6.0

## 8.5.0

### Minor Changes

- 55b8ccdff: Improve usability of Token.FromChainMetadataNativeToken

### Patch Changes

- Updated dependencies [044665692]
  - @hyperlane-xyz/core@5.11.1
  - @hyperlane-xyz/utils@8.5.0

## 8.4.0

### Minor Changes

- f6b682cdb: Deploy to abstract, glue, matchain, unitzero.

### Patch Changes

- Updated dependencies [47ae33c6a]
  - @hyperlane-xyz/core@5.11.0
  - @hyperlane-xyz/utils@8.4.0

## 8.3.0

### Minor Changes

- 7546c0181: Deploy to trumpchain.
- 49856fbb9: Deploy to flametestnet, sonicblaze. Remove support for sonictestnet.

### Patch Changes

- Updated dependencies [db8c09011]
- Updated dependencies [11cf66c5e]
  - @hyperlane-xyz/core@5.10.0
  - @hyperlane-xyz/utils@8.3.0

## 8.2.0

### Minor Changes

- 69a684869: Don't try to build signers for non-EVM chains in MultiProtocolSignerManager

### Patch Changes

- @hyperlane-xyz/utils@8.2.0
- @hyperlane-xyz/core@5.9.2

## 8.1.0

### Minor Changes

- 9ab961a79: Deploy to new chains: artela, guru, hemi, nero, xpla.

### Patch Changes

- 79c61c891: Fix the return type of multisig and aggregation ISMs for zksync-stack chains.
- 9518dbc84: Enroll new validators for artela, guru, hemi, nero, soneium, torus, xpla.
  - @hyperlane-xyz/utils@8.1.0
  - @hyperlane-xyz/core@5.9.1

## 8.0.0

### Major Changes

- 26fbec8f6: Rename TokenConfig related types and utilities for clarity. E.g. `CollateralConfig` to `CollateralTokenConfig`.
  Export more config types and zod schemas

### Minor Changes

- fd20bb1e9: Add FeeHook and Swell to pz and ez eth config generator. Bump up Registry 6.6.0
- 9f6b8c514: Allow self-relaying of all messages if there are multiple in a given dispatch transaction.
- 82cebabe4: Call google storage API directly and remove @google-cloud/storage dependency from the SDK.
- 95cc9571e: Deploy to new chains: arthera, aurora, conflux, conwai, corn, evmos, form, ink, rivalz, soneium, sonic, telos.
- c690ca82f: Deploy to torus.
- e9911bb9d: Added new Sealevel tx submission and priority fee oracle params to agent config types

### Patch Changes

- 472b34670: Bump registry version to v6.3.0.
- 71aefa03e: export BaseMetadataBuilder
- 5942e9cff: Update default validator sets for alephzeroevmmainnet, appchain, lisk, lumiaprism, swell, treasure, vana, zklink.
- de1190656: Export TOKEN_STANDARD_TO_PROVIDER_TYPE, XERC20_STANDARDS, and MINT_LIMITED_STANDARDS maps
- Updated dependencies [79f8197f3]
- Updated dependencies [0eb8d52a4]
- Updated dependencies [8834a8c92]
  - @hyperlane-xyz/utils@8.0.0
  - @hyperlane-xyz/core@5.9.0

## 7.3.0

### Minor Changes

- 2054f4f5b: Require Sealevel native transfers to cover the rent of the recipient
- a96448fa6: Add logic into SDK to enable warp route unenrollment
- 170a0fc73: Add `createHookUpdateTxs()` to `WarpModule.update()` such that it 1) deploys a hook for a warp route _without_ an existing hook, or 2) update an existing hook.
- 9a09afcc7: Deploy to appchain, treasure, zklink.
- 24784af95: Introduce GcpValidator for retrieving announcements, checkpoints and metadata for a Validator posting to a GCP bucket. Uses GcpStorageWrapper for bucket operations.
- 3e8dd70ac: Update validators for boba, duckchain, unichain, vana, bsquared, superseed. Update oort's own validator. Update blockpi's viction validator. Adad luganodes/dsrv to flame validator set.
- aa1ea9a48: updates the warp deployment config schema to be closer to the ica routing schema
- f0b98fdef: Updated the derivation logic to enable ICA ISM metadata building from on chain data to enable self relaying of ICA messages
- ff9e8a72b: Added a getter to derive ATA payer accounts on Sealevel warp routes
- 97c1f80b7: Implement Sealevel IGP quoting
- 323f0f158: Add ICAs management in core apply command
- 61157097b: Deploy to swell & lumiaprism. Parallelise router enrollment in HyperlaneRouterDeployer.

### Patch Changes

- 665a7b8d8: Added decimal consistency checks to the Token checker
  - @hyperlane-xyz/utils@7.3.0
  - @hyperlane-xyz/core@5.8.3

## 7.2.0

### Minor Changes

- 81ab4332f: Remove ismFactoryAddresses from warpConfig
- 4b3537470: Changed the type of defaultMultisigConfigs, to track validator aliases in addition to their addresses.
- fa6d5f5c6: Add decodeIsmMetadata function

### Patch Changes

- Updated dependencies [fa6d5f5c6]
  - @hyperlane-xyz/utils@7.2.0
  - @hyperlane-xyz/core@5.8.2

## 7.1.0

### Minor Changes

- 6f2d50fbd: Updated Fraxtal set to include Superlane validators, updated Flow set
- 1159e0f4b: Enroll new validators for alephzeroevmmainnet, chilizmainnet, flowmainnet, immutablezkevmmainnet, metal, polynomialfi, rarichain, rootstockmainnet, superpositionmainnet, flame, prom, inevm.
- ff2b4e2fb: Added helpers to Token and token adapters to get bridged supply of tokens"
- 0e285a443: Add a validateZodResult util function
- 5db46bd31: Implements persistent relayer for use in CLI
- 0cd65c571: Add chainMetadataToCosmosChain function

### Patch Changes

- Updated dependencies [0e285a443]
  - @hyperlane-xyz/utils@7.1.0
  - @hyperlane-xyz/core@5.8.1

## 7.0.0

### Major Changes

- f48cf8766: Upgrade Viem to 2.2 and Solana Web3 to 1.9
  Rename `chainMetadataToWagmiChain` to `chainMetadataToViemChain`
- 5f41b1134: Remove getCoingeckoTokenPrices (use CoinGeckoTokenPriceGetter instead)

### Minor Changes

- bbb970a44: Redeploy to alephzeroevmmainnet, chilizmainnet, flowmainnet, immutablezkevmmainnet, metal, polynomialfi, rarichain, rootstockmainnet, superpositionmainnet. Deploy to flame, prom.
- fa424826c: Add support for updating the mailbox proxy admin owner
- 40d59a2f4: Deploy to abstracttestnet and treasuretopaz
- 0264f709e: Deploy to alephzeroevmtestnet, update deployment for arcadiatestnet2.
- 836060240: Add storage based multisig ISM types
- f24835438: Added coinGeckoId as an optional property of the TokenConfigSchema

### Patch Changes

- ba0122279: feat: use message context in hook reader IGP derivation
- Updated dependencies [f48cf8766]
- Updated dependencies [836060240]
- Updated dependencies [e6f9d5c4f]
  - @hyperlane-xyz/utils@7.0.0
  - @hyperlane-xyz/core@5.8.0

## 6.0.0

### Major Changes

- e3b97c455: Detangle assumption that chainId == domainId for EVM chains. Domain IDs and Chain Names are still unique, but chainId is no longer guaranteed to be a unique identifier. Domain ID is no longer an optional field and is now required for all chain metadata.

### Minor Changes

- 7b3b07900: Support using apiKey for CoinGeckoTokenPriceGetter
- 30d92c319: Add `collateralChainName` to Warp Reader. Partial refactor of fetchTokenConfig().

### Patch Changes

- Updated dependencies [e3b97c455]
  - @hyperlane-xyz/utils@6.0.0
  - @hyperlane-xyz/core@5.7.1

## 5.7.0

### Minor Changes

- 469f2f340: Checking for sufficient fees in `AbstractMessageIdAuthHook` and refund surplus
- d9505ab58: Deploy to apechain, arbitrumnova, b3, fantom, gravity, harmony, kaia, morph, orderly, snaxchain, zeronetwork, zksync. Update default metadata in `HyperlaneCore` to `0x00001` to ensure empty metadata does not break on zksync.
- 7e9e248be: Add feat to allow updates to destination gas using warp apply
- 4c0605dca: Add optional proxy admin reuse in warp route deployments and admin proxy ownership transfer in warp apply
- db9196837: Update default validator sets. Throw in `InterchainAccount.getOrDeployAccount` if the origin router is the zero address.
- db5875cc2: Add `hyperlane warp verify` to allow post-deployment verification.
- 956ff752a: Introduce utils that can be reused by the CLI and Infra for fetching token prices from Coingecko and gas prices from EVM/Cosmos chains.

### Patch Changes

- 5dabdf388: Optimize HyperlaneRelayer routing config derivation
- e104cf6aa: Dedupe internals of hook and ISM module deploy code
- 56328e6e1: Fix ICA ISM self relay
- Updated dependencies [469f2f340]
- Updated dependencies [e104cf6aa]
- Updated dependencies [04108155d]
- Updated dependencies [f26453ee5]
- Updated dependencies [0640f837c]
- Updated dependencies [a82b4b4cb]
- Updated dependencies [39a9b2038]
  - @hyperlane-xyz/core@5.7.0
  - @hyperlane-xyz/utils@5.7.0

## 5.6.2

### Patch Changes

- 5fd4267e7: Supported non-32 byte non-EVM recipients when sending warps from Sealevel
- Updated dependencies [5fd4267e7]
- Updated dependencies [a36fc5fb2]
- Updated dependencies [a42616ff3]
  - @hyperlane-xyz/utils@5.6.2
  - @hyperlane-xyz/core@5.6.1

## 5.6.1

### Patch Changes

- Updated dependencies [8cc0d9a4a]
- Updated dependencies [c55257cf5]
- Updated dependencies [8cc0d9a4a]
  - @hyperlane-xyz/core@5.6.0
  - @hyperlane-xyz/utils@5.6.1

## 5.6.0

### Minor Changes

- 46044a2e9: Deploy to odysseytestnet
- 02a5b92ba: Enroll new validators. Add tx overrides when deploying ICA accounts. Core checker now surfaces owner violations for defaultHook and requiredHook. App checker temporarily ignores bytecode mismatch violations.
- 29341950e: Adds new `core check` command to compare local configuration and on chain deployments. Adds memoization to the EvmHookReader to avoid repeating configuration derivation
- 8001bbbd6: Add override to some transactions to fix warp apply
- 32d0a67c2: Adds the warp check command to compare warp routes config files with on chain warp route deployments
- b1ff48bd1: Add rebasing yield route support into CLI/SDK
- d41aa6928: Add `EthJsonRpcBlockParameterTag` enum for validating reorgPeriod
- c3e9268f1: Add support for an arbitrary string in `reorgPeriod`, which is used as a block tag to get the finalized block.
- 7d7bcc1a3: Add deployments for mainnets: flow, metall2, polynomial

### Patch Changes

- 7f3e0669d: Fix filtering non-evm addresses in appFromAddressesMapHelper
- 2317eca3c: Set transaction overrides and add 10% gas limit buffer when sending message through HyperlaneCore.
- Updated dependencies [f1712deb7]
- Updated dependencies [29341950e]
- Updated dependencies [c9085afd9]
- Updated dependencies [ec6b874b1]
- Updated dependencies [72c23c0d6]
  - @hyperlane-xyz/utils@5.6.0
  - @hyperlane-xyz/core@5.5.0

## 5.5.0

### Minor Changes

- 2afc484a2: Break out BlockExplorerSchema and export separately
  Migrate RPC + Explorer health tests back to SDK from registry
- 3254472e0: Add deployments for chains: immutablezkevm, rari, rootstock, alephzeroevm, chiliz, lumia, and superposition
- 6176c9861: Add opstack, polygoncdk, polkadotsubstrate and zksync to ChainTechnicalStack enum

### Patch Changes

- fcfe91113: Reuse SDK transaction typings in tx submitters
- Updated dependencies [92c86cca6]
- Updated dependencies [2afc484a2]
  - @hyperlane-xyz/core@5.4.1
  - @hyperlane-xyz/utils@5.5.0

## 5.4.0

### Minor Changes

- 4415ac224: Add Gnosis safe transaction builder to warp apply

### Patch Changes

- Updated dependencies [bb75eba74]
- Updated dependencies [4415ac224]
- Updated dependencies [c5c217f8e]
  - @hyperlane-xyz/core@5.4.0
  - @hyperlane-xyz/utils@5.4.0

## 5.3.0

### Patch Changes

- eb47aaee8: Use collateral account for sealevel native warp route balance
- 50319d8ba: Make HyperlaneDeployer.chainTimeoutMs public.
  Remove HyperlaneDeployer.startingBlockNumbers as it's not used by any deployer.
  Update HyperlaneDeployer.deploy for better logging and error handling.
- 8de531fa4: fix: warn on submodule metadata builder failures
- fd536a79a: Include priority fee instruction with SVM warp transfers
- Updated dependencies [746eeb9d9]
- Updated dependencies [50319d8ba]
  - @hyperlane-xyz/utils@5.3.0
  - @hyperlane-xyz/core@5.3.0

## 5.2.1

### Patch Changes

- Updated dependencies [eb5afcf3e]
  - @hyperlane-xyz/core@5.2.1
  - @hyperlane-xyz/utils@5.2.1

## 5.2.0

### Minor Changes

- a19e882fd: Improve Router Checker/Governor tooling to support enrolling multiple routers for missing domains
- 203084df2: Added sdk support for Stake weighted ISM
- 74a592e58: Adds OwnerCollateral to token mapping which will output the correct standard to the warp deploy artifact.
- 739af9a34: Support providing multiple chains for checking in HyperlaneAppChecker
- 44588c31d: Enroll new validators for cyber degenchain kroma lisk lukso merlin metis mint proofofplay real sanko tangle xai taiko
- 291c5fe36: Use addBufferToGasLimit from @hyperlane-xyz/utils
- 69f17d99a: Fix to correctly infer the default set of multisend addresses for a given chain, and update to latest safe-deployments patch release
- 9563a8beb: Sorted cwNative funds by denom in transfer tx
- 73c232b3a: Deploy to oortmainnet
- 445b6222c: ArbL2ToL1Ism handles value via the executeTransaction branch
- d6de34ad5: Sort values in EvmModuleDeployer.deployStaticAddressSet
- 2e6176f67: Deploy to everclear mainnet
- f2783c03b: Add ChainSubmissionStrategySchema
- 3c07ded5b: Add Safe submit functionality to warp apply

### Patch Changes

- 518a1bef9: add 10% gas bump to initialize call in EvmModuleDeployer
- 2bd540e0f: Estimate and add 10% gas bump for ICA initialization and enrollment
- 3ad5918da: Support DefaultFallbackRoutingIsm in metadata builder
- 2ffb78f5c: Improved check for mailbox initialization
- 815542dd7: Fix arg validation for Sealevel HypNative adapters
  Allow extra properties in ChainMetadata objects
- Updated dependencies [d6de34ad5]
- Updated dependencies [203084df2]
- Updated dependencies [291c5fe36]
- Updated dependencies [445b6222c]
  - @hyperlane-xyz/utils@5.2.0
  - @hyperlane-xyz/core@5.2.0

## 5.1.0

### Minor Changes

- 013f19c64: Add ether's error reasoning handling to SmartProvider to show clearer error messages
- 013f19c64: Support proxiedFactories in HypERC20App and extend HypERC20Checker with ProxiedRouterChecker
- 013f19c64: Deploy to arbitrumsepolia, basesepolia, ecotestnet, optimismsepolia, polygonamoy
- 013f19c64: Deploy to zircuit
- 013f19c64: Update cosmos zod schema and enroll new validators for cheesechain, xlayer, zircuit, worldchain.
- 013f19c64: Added SDK support for ArbL2ToL1Hook/ISM for selfrelay
- 013f19c64: Support proxyAdmin checks for non AW owned warp router contracts
- 013f19c64: Add stride validators to default multisig ism
- 013f19c64: Adds CollateralFiat to token mapping which will output the correct standard to the warp deploy artifact.
- 013f19c64: Deploy to solana + eclipse
- 013f19c64: Added yield route with yield going to message recipient.
- 19f7d4fd9: Support passing foreignDeployments to HypERC20App constructor

### Patch Changes

- 013f19c64: feat: Add long-running CLI relayer
- 013f19c64: Support xERC20Lockbox in checkToken
- 013f19c64: Update ProxyAdminViolation interface to include proxyAdmin and proxy contract fields
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
- Updated dependencies [013f19c64]
  - @hyperlane-xyz/core@5.1.0
  - @hyperlane-xyz/utils@5.1.0

## 5.0.0

### Major Changes

- 488f949ef: Upgrade CosmJS libs to 0.32.4

### Minor Changes

- 2c0ae3cf3: Deploy to connextsepolia + superpositiontestnet
- 0dedbf5a0: Deploy to endurance, fusemainnet, zoramainnet
- 388d25517: Added HyperlaneRelayer for relaying messages from the CLI
- 4907b510c: Add logic to parse SmartProvider errors to handle ethers and smart provider errors
- c7f5a35e8: Add hyperlane core apply with update default Ism
- f83b492de: - Enable updating of hooks through the `EvmHookModule`, including IGP and gas oracles.
  - Drive-by fixes to ISM module and tests.
- 79740755b: Add enroll remote router to WarpModule
- 8533f9e66: Adds transferOwnership to warp update to allow ownership to be transferred if the onchain owner differ
- ed65556aa: Improve WarpCore validation error message for IGP fee checks
- cfb890dc6: Remove outdated logos in SDK (now in registry)
- 708999433: Adds hyperlane warp apply
- 5529d98d0: Add hyperlane core apply with update ownership
- 62d71fad3: Add hyperlane warp update to extend a warp config
- 49986aa92: Add collateralAddressOrDenom for collateralVault
- 8e942d3c6: Deploy to cheesechain, worldchain, xlayer

### Patch Changes

- 69a39da1c: Fix issue with cosmos tx estimation
- 7265a4087: Add rpcUrl, chainId, and method(params) to smart provider logging.
- 0a40dcb8b: Update cosmos chain schema
- ab827a3fa: Removes inaccurate contract verification check, resulting in proxy contracts not being marked as proxies during contract verification.
- dfa908796: add error message for all calls to assert util
- ed63e04c4: Creates HyperlaneReader to re-use dyn provider log level & silences provider logs in deriveIsmConfig like deriveHookConfig.
- 5aa24611b: Add 'isInitialized' check before initializing implementation contract (for contracts that disableInitializers in constructors).
- 7fdd3958d: Adds logic to prune and minify build artifacts to address 'entity size too large' error thrown from explorers. Note that the only identified instance of this issue is on BSC mainnet.
- fef629673: ContractVerifier now adjusts timeouts based on explorer family, which helps with many rate-limiting related contract verification issues. In addition, the ContractVerifier verify logic has been greatly simplified to allowing for a predictable callstack + easy debugging.
- be4617b18: Handle subdirectories for the folder in S3Validator class
- Updated dependencies [388d25517]
- Updated dependencies [488f949ef]
- Updated dependencies [dfa908796]
- Updated dependencies [90598ad44]
- Updated dependencies [1474865ae]
  - @hyperlane-xyz/utils@5.0.0
  - @hyperlane-xyz/core@5.0.0

## 4.1.0

### Minor Changes

- 36e75af4e: Add optional deployer field to ChainMetadata schema
- d31677224: Deploy to bob, mantle, taiko
- 4cc9327e5: Update warp deploy to handle xerc20, initializerArgs to be the signer, update deploy gas constants
- 1687fca93: Add EvmWarpModule with update() for ISM

### Patch Changes

- @hyperlane-xyz/core@4.1.0
- @hyperlane-xyz/utils@4.1.0

## 4.0.0

### Minor Changes

- b05ae38ac: Gracefully handle RPC failures during warp send & fix deriving hook error that prevents warp and core test messages on the cli.
- 9304fe241: Use metadata builders in message relaying
- bdcbe1d16: Add EvmWarpModule with create()
- e38d31685: Add logic to set smart provider log level to disable provider logs during Warp TokenType derive
- e0f226806: - Enables creation of new Hooks through the `EvmHookModule`.
  - Introduces an `EvmModuleDeployer` to perform the barebones tasks of deploying contracts/proxies.
- 6db9fa9ad: Implement hyperlane warp deploy

### Patch Changes

- 6b63c5d82: Adds deployment support for IsmConfig within a WarpRouteConfig
- Updated dependencies [44cc9bf6b]
  - @hyperlane-xyz/core@4.0.0
  - @hyperlane-xyz/utils@4.0.0

## 3.16.0

### Minor Changes

- 5cc64eb09: Add validator addresses for linea, fraxtal, sei.
  Estimate gas and add 10% buffer inside HyperlaneIsmFactory as well.

### Patch Changes

- f9bbdde76: Fix initial total supply of synthetic token deployments to 0
  - @hyperlane-xyz/core@3.16.0
  - @hyperlane-xyz/utils@3.16.0

## 3.15.1

### Patch Changes

- acaa22cd9: Do not consider xERC20 a collateral standard to fix fungibility checking logic while maintaining mint limit checking
- 921e449b4: Support priorityFee fetching from RPC and some better logging
- Updated dependencies [6620fe636]
  - @hyperlane-xyz/core@3.15.1
  - @hyperlane-xyz/utils@3.15.1

## 3.15.0

### Minor Changes

- 51bfff683: Mint/burn limit checking for xERC20 bridging
  Corrects CLI output for HypXERC20 and HypXERC20Lockbox deployments

### Patch Changes

- Updated dependencies [51bfff683]
  - @hyperlane-xyz/core@3.15.0
  - @hyperlane-xyz/utils@3.15.0

## 3.14.0

### Patch Changes

- Updated dependencies [a8a68f6f6]
  - @hyperlane-xyz/core@3.14.0
  - @hyperlane-xyz/utils@3.14.0

## 3.13.0

### Minor Changes

- 39ea7cdef: Implement multi collateral warp routes
- babe816f8: Support xERC20 and xERC20 Lockbox in SDK and CLI
- 0cf692e73: Implement metadata builder fetching from message

### Patch Changes

- Updated dependencies [babe816f8]
- Updated dependencies [b440d98be]
- Updated dependencies [0cf692e73]
  - @hyperlane-xyz/core@3.13.0
  - @hyperlane-xyz/utils@3.13.0

## 3.12.0

### Minor Changes

- 69de68a66: Implement aggregation and multisig ISM metadata encoding

### Patch Changes

- eba393680: Exports submitter and transformer props types.
- Updated dependencies [69de68a66]
  - @hyperlane-xyz/utils@3.12.0
  - @hyperlane-xyz/core@3.12.0

## 3.11.1

### Patch Changes

- c900da187: Workaround TS bug in Safe protocol-lib
  - @hyperlane-xyz/core@3.11.1
  - @hyperlane-xyz/utils@3.11.1

## 3.11.0

### Minor Changes

- 811ecfbba: Add EvmCoreReader, minor updates.
- f8b6ea467: Update the warp-route-deployment.yaml to a more sensible schema. This schema sets us up to allow multi-chain collateral deployments. Removes intermediary config objects by using zod instead.
- d37cbab72: Adds modular transaction submission support for SDK clients, e.g. CLI.
- b6fdf2f7f: Implement XERC20 and FiatToken collateral warp routes
- 2db77f177: Added RPC `concurrency` property to `ChainMetadata`.
  Added `CrudModule` abstraction and related types.
  Removed `Fuel` ProtocolType.
- 3a08e31b6: Add EvmERC20WarpRouterReader to derive WarpConfig from TokenRouter address
- 917266dce: Add --self-relay to CLI commands
- aab63d466: Adding ICA for governance
- b63714ede: Convert all public hyperlane npm packages from CJS to pure ESM
- 3528b281e: Remove consts such as chainMetadata from SDK
- 450e8e0d5: Migrate fork util from CLI to SDK. Anvil IP & Port are now optionally passed into fork util by client.
- af2634207: Moved Hook/ISM config stringify into a general object stringify utility.

### Patch Changes

- a86a8296b: Removes Gnosis safe util from infra in favor of SDK
- 2e439423e: Allow gasLimit overrides in the SDK/CLI for deploy txs
- Updated dependencies [b6fdf2f7f]
- Updated dependencies [b63714ede]
- Updated dependencies [2b3f75836]
- Updated dependencies [af2634207]
  - @hyperlane-xyz/core@3.11.0
  - @hyperlane-xyz/utils@3.11.0

## 3.10.0

### Minor Changes

- 96485144a: SDK support for ICA deployment and operation.
- 38358ecec: Deprecate Polygon Mumbai testnet (soon to be replaced by Polygon Amoy testnet)
- ed0d4188c: Fixed an issue where warp route verification would fail at deploy time due to a mismatch between the SDK's intermediary contract representation and actual contract name.
  Enabled the ContractVerifier to pick up explorer API keys from the configured chain metadata. This allows users to provide their own explorer API keys in custom `chains.yaml` files.
- 4e7a43be6: Replace Debug logger with Pino

### Patch Changes

- Updated dependencies [96485144a]
- Updated dependencies [38358ecec]
- Updated dependencies [4e7a43be6]
  - @hyperlane-xyz/utils@3.10.0
  - @hyperlane-xyz/core@3.10.0

## 3.9.0

### Minor Changes

- 11f257ebc: Add Yield Routes to CLI

### Patch Changes

- @hyperlane-xyz/core@3.9.0
- @hyperlane-xyz/utils@3.9.0

## 3.8.2

### Patch Changes

- @hyperlane-xyz/core@3.8.2
- @hyperlane-xyz/utils@3.8.2

## 3.8.1

### Patch Changes

- 5daaae274: Prevent warp transfers to zero-ish addresses
- Updated dependencies [5daaae274]
  - @hyperlane-xyz/utils@3.8.1
  - @hyperlane-xyz/core@3.8.1

## 3.8.0

### Minor Changes

- 9681df08d: **New Feature**: Add transaction fee estimators to the SDK
  **Breaking change**: Token Adapter `quoteGasPayment` method renamed to `quoteTransferRemoteGas` for clarity.
- 9681df08d: Remove support for goerli networks (including optimismgoerli, arbitrumgoerli, lineagoerli and polygonzkevmtestnet)
- 9681df08d: Enabled verification of contracts as part of the deployment flow.

  - Solidity build artifact is now included as part of the `@hyperlane-xyz/core` package.
  - Updated the `HyperlaneDeployer` to perform contract verification immediately after deploying a contract. A default verifier is instantiated using the core build artifact.
  - Updated the `HyperlaneIsmFactory` to re-use the `HyperlaneDeployer` for deployment where possible.
  - Minor logging improvements throughout deployers.

- 9681df08d: Add `WarpCore`, `Token`, and `TokenAmount` classes for interacting with Warp Route instances.

  _Breaking change_: The params to the `IHypTokenAdapter` `populateTransferRemoteTx` method have changed. `txValue` has been replaced with `interchainGas`.

### Patch Changes

- 9681df08d: Support configuring non-EVM IGP destinations
- 9681df08d: Removed basegoerli and moonbasealpha testnets
- 9681df08d: Add logos for plume to SDK
- 9681df08d: TestRecipient as part of core deployer
- 9681df08d: Update viction validator set
- 9681df08d: Minor fixes for SDK cosmos logos
- 9681df08d: Implement message id extraction for CosmWasmCoreAdapter
- 9681df08d: Patch transfer ownership in hook deployer
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
- Updated dependencies [9681df08d]
  - @hyperlane-xyz/core@3.8.0
  - @hyperlane-xyz/utils@3.8.0

## 3.7.0

### Minor Changes

- 54aeb6420: Added warp route artifacts type adopting registry schema

### Patch Changes

- 6f464eaed: Add logos for injective and nautilus
- 87151c62b: Bumped injective reorg period
- ab17af5f7: Updating HyperlaneIgpDeployer to configure storage gas oracles as part of deployment
- 7b40232af: Remove unhealthy zkevm rpc
  - @hyperlane-xyz/core@3.7.0
  - @hyperlane-xyz/utils@3.7.0

## 3.6.2

### Patch Changes

- @hyperlane-xyz/core@3.6.2
- @hyperlane-xyz/utils@3.6.2

## 3.6.1

### Patch Changes

- ae4476ad0: Bumped mantapacific reorgPeriod to 1, a reorg period in chain metadata is now required by infra.
- f3b7ddb69: Add optional grpcUrl field to ChainMetadata
- e4e4f93fc: Support pausable ISM in deployer and checker
- Updated dependencies [3c298d064]
- Updated dependencies [df24eec8b]
- Updated dependencies [78e50e7da]
- Updated dependencies [e4e4f93fc]
  - @hyperlane-xyz/utils@3.6.1
  - @hyperlane-xyz/core@3.6.1

## 3.6.0

### Minor Changes

- 0488ef31d: Add dsrv, staked and zeeprime as validators
- 8d8ba3f7a: HyperlaneIsmFactory is now wary of (try)getDomainId or (try)getChainName calls which may fail and handles them appropriately.

### Patch Changes

- 67a6d971e: Added `shouldRecover` flag to deployContractFromFactory so that the `TestRecipientDeployer` can deploy new contracts if it's not the owner of the prior deployments (We were recovering the SDK artifacts which meant the deployer won't be able to set the ISM as they needed)
- 612d4163a: Add mailbox version const to SDK
  - @hyperlane-xyz/core@3.6.0
  - @hyperlane-xyz/utils@3.6.0

## 3.5.1

### Patch Changes

- a04454d6d: Use getBalance instead of queryContractSmart for CwTokenAdapter
  - @hyperlane-xyz/core@3.5.1
  - @hyperlane-xyz/utils@3.5.1

## 3.5.0

### Minor Changes

- 655b6a0cd: Redeploy Routing ISM Factories

### Patch Changes

- 08ba0d32b: Remove dead arbitrum goerli explorer link"
- f7d285e3a: Adds Test Recipient addresses to the SDK artifacts
  - @hyperlane-xyz/core@3.5.0
  - @hyperlane-xyz/utils@3.5.0

## 3.4.0

### Minor Changes

- b832e57ae: Replace Fallback and Retry Providers with new SmartProvider with more effective fallback/retry logic

### Patch Changes

- 7919417ec: Granular control of updating predeployed routingIsms based on routing config mismatch
  - Add support for routingIsmDelta which filters out the incompatibility between the onchain deployed config and the desired config.
  - Based on the above, you either update the deployed Ism with new routes, delete old routes, change owners, etc.
  - `moduleMatchesConfig` uses the same
- fd4fc1898: - Upgrade Viem to 1.20.0
  - Add optional restUrls field to ChainMetadata
  - Add deepCopy util function
  - Add support for cosmos factory token addresses
- e06fe0b32: Supporting DefaultFallbackRoutingIsm through non-factory deployments
- 79c96d718: Remove healthy RPC URLs and remove NeutronTestnet
- Updated dependencies [fd4fc1898]
- Updated dependencies [e06fe0b32]
  - @hyperlane-xyz/utils@3.4.0
  - @hyperlane-xyz/core@3.4.0

## 3.3.0

### Patch Changes

- 7e620c9df: Allow CLI to accept hook as a config
- 350175581: Rename StaticProtocolFee hook to ProtocolFee for clarity
- 9f2c7ce7c: Removing agentStartBlocks and using mailbox.deployedBlock() instead
- Updated dependencies [350175581]
  - @hyperlane-xyz/core@3.3.0
  - @hyperlane-xyz/utils@3.3.0

## 3.2.0

### Minor Changes

- df693708b: Add support for all ISM types in CLI interactive config creation

### Patch Changes

- Updated dependencies [df34198d4]
  - @hyperlane-xyz/core@3.2.0
  - @hyperlane-xyz/utils@3.2.0

## 3.1.10

### Patch Changes

- Updated dependencies [c9e0aedae]
  - @hyperlane-xyz/core@3.1.10
  - @hyperlane-xyz/utils@3.1.10
