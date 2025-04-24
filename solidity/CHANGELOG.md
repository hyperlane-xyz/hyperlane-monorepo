# @hyperlane-xyz/core

## 7.1.1

### Patch Changes

- @hyperlane-xyz/utils@12.2.0

## 7.1.0

### Minor Changes

- e6f6d61a0: Refactor ZKsync artifact generation and validation logic

### Patch Changes

- @hyperlane-xyz/utils@12.1.0

## 7.0.0

### Major Changes

- 59a087ded: Remove unused FastTokenRouter
- 59a087ded: ## Changes

  Add immutable `scale` parameter to all warp route variants which scales outbound amounts **down** and inbound amounts **up**. This is useful when different chains of the route have different decimal places to unify semantics of amounts in messages.

  Removes `HypNativeScaled` in favor of `HypNative` with `scale` parameter.

  ## Migration

  If you want to keep the same behavior as before, you can set `scale` to `1` in all your routes.

  ### `HypNativeScaled` Usage

  ```diff
  - HypNativeScaled(scale, mailbox)
  + HypNative(scale, mailbox)
  ```

  ### `HypERC20` Usage

  ```diff
  - HypERC20(decimals, mailbox)
  + HypERC20(decimals, scale, mailbox)
  ```

  ### `HypERC20Collateral` Usage

  ```diff
  - HypERC20Collateral(erc20, mailbox)
  + HypERC20Collateral(erc20, scale, mailbox)
  ```

### Minor Changes

- 07321f6f0: Add ZKSync support and restructure build artifacts:

  - Add ZKSync compilation support
  - Restructure typechain directory location to core-utils/typechain
  - Add ZKSync-specific artifact generation and exports
  - Update build process to handle both standard and ZKSync artifacts
  - Add new exports for ZKSync build artifacts and contract types

- 59a087ded: Fixed misuse of aggregation hook funds for relaying messages by making sure msg.value is adequate and refunding if excess.

### Patch Changes

- 59a087ded: Refactor TokenRouter internal amount accounting for use in scaling Warp Routes
- 59a087ded: Fix yield route (`HypERC4626`/`HypERC4626Collateral`) decimal scaling by leveraging `FungibleTokenRouter`
  - @hyperlane-xyz/utils@12.0.0

## 6.1.0

### Minor Changes

- cd0424595: Add ZKSync support and restructure build artifacts:

  - Add ZKSync compilation support
  - Restructure typechain directory location to core-utils/typechain
  - Add ZKSync-specific artifact generation and exports
  - Update build process to handle both standard and ZKSync artifacts
  - Add new exports for ZKSync build artifacts and contract types

### Patch Changes

- Updated dependencies [3b060c3e1]
  - @hyperlane-xyz/utils@11.0.0

## 6.0.4

### Patch Changes

- fff9cbf57: pin zksync deps from ccip package
- Updated dependencies [b8d95fc95]
  - @hyperlane-xyz/utils@10.0.0

## 6.0.3

### Patch Changes

- @hyperlane-xyz/utils@9.2.1

## 6.0.2

### Patch Changes

- @hyperlane-xyz/utils@9.2.0

## 6.0.1

### Patch Changes

- @hyperlane-xyz/utils@9.1.0

## 6.0.0

### Major Changes

- 88970a78c: ## Changes

  Add immutable `scale` parameter to all warp route variants which scales outbound amounts **down** and inbound amounts **up**. This is useful when different chains of the route have different decimal places to unify semantics of amounts in messages.

  Removes `HypNativeScaled` in favor of `HypNative` with `scale` parameter.

  ## Migration

  If you want to keep the same behavior as before, you can set `scale` to `1` in all your routes.

  ### `HypNativeScaled` Usage

  ```diff
  - HypNativeScaled(scale, mailbox)
  + HypNative(scale, mailbox)
  ```

  ### `HypERC20` Usage

  ```diff
  - HypERC20(decimals, mailbox)
  + HypERC20(decimals, scale, mailbox)
  ```

  ### `HypERC20Collateral` Usage

  ```diff
  - HypERC20Collateral(erc20, mailbox)
  + HypERC20Collateral(erc20, scale, mailbox)
  ```

### Minor Changes

- 88970a78c: Fixed misuse of aggregation hook funds for relaying messages by making sure msg.value is adequate and refunding if excess.

### Patch Changes

- 88970a78c: Refactor TokenRouter internal amount accounting for use in scaling Warp Routes
- Updated dependencies [4df37393f]
  - @hyperlane-xyz/utils@9.0.0

## 5.12.0

### Minor Changes

- 1a0eba65b: Implement warp route amount routing ISM
- 05f89650b: Added utils for fetching extra lockboxes data from a xERC20 warp route
- 9a010dfc1: Implement CCIP hook and ISM with unordered execution
- 1a0eba65b: Implement warp amount routing hook
- f3c67a214: Implement mailbox.defaultHook redirect
- 03266e2c2: add amount routing hook support in the sdk and cli
- 4147f91cb: Added AmountRoutingIsm support to the IsmReader and Factory

### Patch Changes

- 27eadbfc3: Add internal refund logic to hooks
- Updated dependencies [05f89650b]
- Updated dependencies [3518f8901]
  - @hyperlane-xyz/utils@8.9.0

## 5.11.6

### Patch Changes

- @hyperlane-xyz/utils@8.8.1

## 5.11.5

### Patch Changes

- @hyperlane-xyz/utils@8.8.0

## 5.11.4

### Patch Changes

- @hyperlane-xyz/utils@8.7.0

## 5.11.3

### Patch Changes

- @hyperlane-xyz/utils@8.6.1

## 5.11.2

### Patch Changes

- ba50e62fc: Added ESLint configuration and dependency to enforce Node.js module restrictions
  - @hyperlane-xyz/utils@8.6.0

## 5.11.1

### Patch Changes

- 044665692: Make `initialize` function public virtual
  - @hyperlane-xyz/utils@8.5.0

## 5.11.0

### Minor Changes

- 47ae33c6a: Revert zksync changes.

### Patch Changes

- @hyperlane-xyz/utils@8.4.0

## 5.10.0

### Minor Changes

- db8c09011: Add ZKSync support and restructure build artifacts:

  - Add ZKSync compilation support
  - Restructure typechain directory location to core-utils/typechain
  - Add ZKSync-specific artifact generation and exports
  - Update build process to handle both standard and ZKSync artifacts
  - Add new exports for ZKSync build artifacts and contract types

### Patch Changes

- 11cf66c5e: Export empty zksync buildArtifact to satisfy package.json exports
  - @hyperlane-xyz/utils@8.3.0

## 5.9.2

### Patch Changes

- @hyperlane-xyz/utils@8.2.0

## 5.9.1

### Patch Changes

- @hyperlane-xyz/utils@8.1.0

## 5.9.0

### Minor Changes

- 0eb8d52a4: Made releaseValueToRecipient internal

### Patch Changes

- Updated dependencies [79f8197f3]
- Updated dependencies [8834a8c92]
  - @hyperlane-xyz/utils@8.0.0

## 5.8.3

### Patch Changes

- @hyperlane-xyz/utils@7.3.0

## 5.8.2

### Patch Changes

- Updated dependencies [fa6d5f5c6]
  - @hyperlane-xyz/utils@7.2.0

## 5.8.1

### Patch Changes

- Updated dependencies [0e285a443]
  - @hyperlane-xyz/utils@7.1.0

## 5.8.0

### Minor Changes

- 836060240: Add storage based multisig ISM types

### Patch Changes

- Updated dependencies [f48cf8766]
- Updated dependencies [e6f9d5c4f]
  - @hyperlane-xyz/utils@7.0.0

## 5.7.1

### Patch Changes

- Updated dependencies [e3b97c455]
  - @hyperlane-xyz/utils@6.0.0

## 5.7.0

### Minor Changes

- 469f2f340: Checking for sufficient fees in `AbstractMessageIdAuthHook` and refund surplus
- f26453ee5: Added msg.value to preverifyMessage to commit it as part of external hook payload
- 0640f837c: disabled the ICARouter's ability to change hook given that the user doesn't expect the hook to change after they deploy their ICA account. Hook is not part of the derivation like ism on the destination chain and hence, cannot be configured custom by the user.
- a82b4b4cb: Made processInboundMessage payable to send value via mailbox.process

### Patch Changes

- Updated dependencies [e104cf6aa]
- Updated dependencies [04108155d]
- Updated dependencies [39a9b2038]
  - @hyperlane-xyz/utils@5.7.0

## 5.6.1

### Patch Changes

- a42616ff3: Added overrides for transferFrom, totalSupply to reflect the internal share based accounting for the 4626 mirror asset
- Updated dependencies [5fd4267e7]
- Updated dependencies [a36fc5fb2]
  - @hyperlane-xyz/utils@5.6.2

## 5.6.0

### Minor Changes

- c55257cf5: Minor token related changes like adding custom hook to 4626 collateral, checking for ERC20 as valid contract in HypERC20Collateral, etc.
- 8cc0d9a4a: Added WHypERC4626 as a wrapper for rebasing HypERC4626

### Patch Changes

- 8cc0d9a4a: Add wrapped HypERC4626 for easy defi use
  - @hyperlane-xyz/utils@5.6.1

## 5.5.0

### Minor Changes

- 72c23c0d6: Added PRECISION and rateUpdateNonce to ensure compatibility of HypERC4626

### Patch Changes

- c9085afd9: Patched OPL2ToL1Ism to check for correct messageId for external call in verify
- ec6b874b1: Added nonce to HypERC4626
- Updated dependencies [f1712deb7]
- Updated dependencies [29341950e]
  - @hyperlane-xyz/utils@5.6.0

## 5.4.1

### Patch Changes

- 92c86cca6: Forward value from ICA router to proxy for multicall
- Updated dependencies [2afc484a2]
  - @hyperlane-xyz/utils@5.5.0

## 5.4.0

### Minor Changes

- bb75eba74: fix: constrain rate limited ISM to a single message recipient
- c5c217f8e: Embed NPM package version in bytecode constant

### Patch Changes

- Updated dependencies [4415ac224]
  - @hyperlane-xyz/utils@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [746eeb9d9]
- Updated dependencies [50319d8ba]
  - @hyperlane-xyz/utils@5.3.0

## 5.2.1

### Patch Changes

- eb5afcf3e: Patch `HypNative` with hook overrides `transferRemote` behavior
  - @hyperlane-xyz/utils@5.2.1

## 5.2.0

### Minor Changes

- 203084df2: Added sdk support for Stake weighted ISM
- 445b6222c: ArbL2ToL1Ism handles value via the executeTransaction branch

### Patch Changes

- Updated dependencies [d6de34ad5]
- Updated dependencies [291c5fe36]
  - @hyperlane-xyz/utils@5.2.0

## 5.1.0

### Minor Changes

- 013f19c64: Added SDK support for ArbL2ToL1Hook/ISM for selfrelay
- 013f19c64: Added hook/ism for using the Optimism native bridge for L2->L1 calls
- 013f19c64: Added yield route with yield going to message recipient.
- 013f19c64: feat: attributable fraud for signers
- 013f19c64: Implement checkpoint fraud proofs for use in slashing

### Patch Changes

- 013f19c64: fix: only evaluate dynamic revert reasons in reverting branch
  - @hyperlane-xyz/utils@5.1.0

## 5.0.0

### Patch Changes

- 90598ad44: Removed outbox as param for ArbL2ToL1Ism
- Updated dependencies [388d25517]
- Updated dependencies [488f949ef]
- Updated dependencies [dfa908796]
- Updated dependencies [1474865ae]
  - @hyperlane-xyz/utils@5.0.0

## 4.1.0

### Patch Changes

- @hyperlane-xyz/utils@4.1.0

## 4.0.0

### Minor Changes

- 44cc9bf6b: Add CLI command to support AVS validator status check

### Patch Changes

- @hyperlane-xyz/utils@4.0.0

## 3.16.0

### Patch Changes

- @hyperlane-xyz/utils@3.16.0

## 3.15.1

### Patch Changes

- 6620fe636: fix: `TokenRouter.transferRemote` with hook overrides
  - @hyperlane-xyz/utils@3.15.1

## 3.15.0

### Minor Changes

- 51bfff683: Mint/burn limit checking for xERC20 bridging
  Corrects CLI output for HypXERC20 and HypXERC20Lockbox deployments

### Patch Changes

- @hyperlane-xyz/utils@3.15.0

## 3.14.0

### Patch Changes

- a8a68f6f6: fix: make XERC20 and XERC20 Lockbox proxy-able
  - @hyperlane-xyz/utils@3.14.0

## 3.13.0

### Minor Changes

- babe816f8: Support xERC20 and xERC20 Lockbox in SDK and CLI
- b440d98be: Added support for registering/deregistering from the Hyperlane AVS

### Patch Changes

- Updated dependencies [0cf692e73]
  - @hyperlane-xyz/utils@3.13.0

## 3.12.0

### Patch Changes

- Updated dependencies [69de68a66]
  - @hyperlane-xyz/utils@3.12.0

## 3.11.1

### Patch Changes

- @hyperlane-xyz/utils@3.11.1

## 3.11.0

### Minor Changes

- b6fdf2f7f: Implement XERC20 and FiatToken collateral warp routes
- b63714ede: Convert all public hyperlane npm packages from CJS to pure ESM

### Patch Changes

- Updated dependencies [b63714ede]
- Updated dependencies [2b3f75836]
- Updated dependencies [af2634207]
  - @hyperlane-xyz/utils@3.11.0

## 3.10.0

### Minor Changes

- 96485144a: SDK support for ICA deployment and operation.
- 38358ecec: Deprecate Polygon Mumbai testnet (soon to be replaced by Polygon Amoy testnet)

### Patch Changes

- Updated dependencies [96485144a]
- Updated dependencies [4e7a43be6]
  - @hyperlane-xyz/utils@3.10.0

## 3.9.0

### Patch Changes

- @hyperlane-xyz/utils@3.9.0

## 3.8.2

### Patch Changes

- @hyperlane-xyz/utils@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [5daaae274]
  - @hyperlane-xyz/utils@3.8.1

## 3.8.0

### Minor Changes

- 9681df08d: Remove support for goerli networks (including optimismgoerli, arbitrumgoerli, lineagoerli and polygonzkevmtestnet)
- 9681df08d: Enabled verification of contracts as part of the deployment flow.

  - Solidity build artifact is now included as part of the `@hyperlane-xyz/core` package.
  - Updated the `HyperlaneDeployer` to perform contract verification immediately after deploying a contract. A default verifier is instantiated using the core build artifact.
  - Updated the `HyperlaneIsmFactory` to re-use the `HyperlaneDeployer` for deployment where possible.
  - Minor logging improvements throughout deployers.

### Patch Changes

- Updated dependencies [9681df08d]
  - @hyperlane-xyz/utils@3.8.0

## 3.7.0

### Patch Changes

- @hyperlane-xyz/utils@3.7.0

## 3.6.2

### Patch Changes

- @hyperlane-xyz/utils@3.6.2

## 3.6.1

### Patch Changes

- e4e4f93fc: Support pausable ISM in deployer and checker
- Updated dependencies [3c298d064]
- Updated dependencies [df24eec8b]
- Updated dependencies [78e50e7da]
  - @hyperlane-xyz/utils@3.6.1

## 3.6.0

### Patch Changes

- @hyperlane-xyz/utils@3.6.0

## 3.5.1

### Patch Changes

- @hyperlane-xyz/utils@3.5.1

## 3.5.0

### Patch Changes

- @hyperlane-xyz/utils@3.5.0

## 3.4.0

### Patch Changes

- e06fe0b32: Supporting DefaultFallbackRoutingIsm through non-factory deployments
- Updated dependencies [fd4fc1898]
  - @hyperlane-xyz/utils@3.4.0

## 3.3.0

### Patch Changes

- 350175581: Rename StaticProtocolFee hook to ProtocolFee for clarity
  - @hyperlane-xyz/utils@3.3.0

## 3.2.0

### Minor Changes

- df34198d4: Includes storage gap in Mailbox Client for forwards compatibility

### Patch Changes

- @hyperlane-xyz/utils@3.2.0

## 3.1.10

### Patch Changes

- c9e0aedae: Improve client side StandardHookMetadata library interface
  - @hyperlane-xyz/utils@3.1.10
