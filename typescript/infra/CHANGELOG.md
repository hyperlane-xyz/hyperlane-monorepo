# @hyperlane-xyz/infra

## 13.1.1

### Patch Changes

- ba4deea: Revert workspace dependency syntax.
- Updated dependencies [ba4deea]
  - @hyperlane-xyz/helloworld@13.1.1
  - @hyperlane-xyz/sdk@13.1.1
  - @hyperlane-xyz/utils@13.1.1

## 13.1.0

### Patch Changes

- Updated dependencies [6e86efa]
- Updated dependencies [c42ea09]
- Updated dependencies [f41f766]
  - @hyperlane-xyz/sdk@13.1.0
  - @hyperlane-xyz/utils@13.1.0
  - @hyperlane-xyz/helloworld@13.1.0

## 13.0.0

### Patch Changes

- Updated dependencies [72b90f8]
- Updated dependencies [bc58283]
- Updated dependencies [0de63e0]
- Updated dependencies [2724559]
  - @hyperlane-xyz/sdk@13.0.0
  - @hyperlane-xyz/utils@13.0.0
  - @hyperlane-xyz/helloworld@13.0.0

## 12.6.0

### Minor Changes

- 1770318: Upgraded @hyperlane-xyz/registry to v14.0.0 and updated warp route config API usage.

### Patch Changes

- Updated dependencies [76f0eba]
- Updated dependencies [2ae0f72]
- Updated dependencies [672d6d1]
- Updated dependencies [1770318]
- Updated dependencies [1f370e6]
- Updated dependencies [7d56f2c]
- Updated dependencies [6a70b8d]
- Updated dependencies [d182d7d]
- Updated dependencies [248d2e1]
- Updated dependencies [e2a4727]
- Updated dependencies [b360802]
- Updated dependencies [e381a8d]
- Updated dependencies [f6ed6ad]
- Updated dependencies [31ee1c6]
- Updated dependencies [a36d5c1]
  - @hyperlane-xyz/sdk@12.6.0
  - @hyperlane-xyz/helloworld@12.6.0
  - @hyperlane-xyz/utils@12.6.0

## 12.5.0

### Patch Changes

- Updated dependencies [c8ace88]
  - @hyperlane-xyz/sdk@12.5.0
  - @hyperlane-xyz/helloworld@12.5.0
  - @hyperlane-xyz/utils@12.5.0

## 12.4.0

### Patch Changes

- Updated dependencies [d2babb7]
  - @hyperlane-xyz/sdk@12.4.0
  - @hyperlane-xyz/helloworld@12.4.0
  - @hyperlane-xyz/utils@12.4.0

## 12.3.0

### Minor Changes

- 6101959f7: Enhanced the router enrollment check to support non-fully connected warp routes using the `remoteRouters` property from the deployment config.

### Patch Changes

- Updated dependencies [6101959f7]
- Updated dependencies [5db39f493]
- Updated dependencies [7500bd6fe]
  - @hyperlane-xyz/sdk@12.3.0
  - @hyperlane-xyz/utils@12.3.0
  - @hyperlane-xyz/helloworld@12.3.0

## 12.2.0

### Patch Changes

- Updated dependencies [c7934f711]
- Updated dependencies [ecbacbdf2]
  - @hyperlane-xyz/sdk@12.2.0
  - @hyperlane-xyz/helloworld@12.2.0
  - @hyperlane-xyz/utils@12.2.0

## 12.1.0

### Minor Changes

- acbf5936a: New check: HyperlaneRouterChecker now compares the list of domains
  the Router is enrolled with against the warp route expectations.
  It will raise a violation for missing remote domains.
  `check-deploy` and `check-warp-deploy` scripts use this new check.

### Patch Changes

- Updated dependencies [acbf5936a]
- Updated dependencies [c757b6a18]
- Updated dependencies [a646f9ca1]
- Updated dependencies [3b615c892]
  - @hyperlane-xyz/sdk@12.1.0
  - @hyperlane-xyz/helloworld@12.1.0
  - @hyperlane-xyz/utils@12.1.0

## 12.0.0

### Minor Changes

- d478ffd08: updated warp ids and added new soon routes

### Patch Changes

- Updated dependencies [f7ca32315]
- Updated dependencies [4d3738d14]
- Updated dependencies [07321f6f0]
- Updated dependencies [59a087ded]
- Updated dependencies [59a087ded]
- Updated dependencies [337193305]
  - @hyperlane-xyz/sdk@12.0.0
  - @hyperlane-xyz/helloworld@12.0.0
  - @hyperlane-xyz/utils@12.0.0

## 11.0.0

### Minor Changes

- 888d180b6: Fixes a small bug when initializing a token adapter that caused the wrong adapter to be chosen when interacting with svm chains + add new warp ids for new soon wr deployments

### Patch Changes

- Updated dependencies [888d180b6]
- Updated dependencies [3b060c3e1]
  - @hyperlane-xyz/sdk@11.0.0
  - @hyperlane-xyz/utils@11.0.0
  - @hyperlane-xyz/helloworld@11.0.0

## 10.0.0

### Patch Changes

- 4fd5623b8: Fixes a bug where `SealevelHypCollateralAdapter` initialization logic erroneously set the `isSpl2022` property to false.

  It updates the `Token.getHypAdapter` and `Token.getAdapter` methods to be async so that before creating an instance of the `SealevelHypCollateralAdapter` class, the collateral account info can be retrieved on chain to set the correct spl standard.

- Updated dependencies [7dbf7e4fa]
- Updated dependencies [b8d95fc95]
- Updated dependencies [28ca87293]
- Updated dependencies [4fd5623b8]
  - @hyperlane-xyz/sdk@10.0.0
  - @hyperlane-xyz/utils@10.0.0
  - @hyperlane-xyz/helloworld@10.0.0

## 9.2.1

### Patch Changes

- Updated dependencies [e3d09168e]
  - @hyperlane-xyz/sdk@9.2.1
  - @hyperlane-xyz/helloworld@9.2.1
  - @hyperlane-xyz/utils@9.2.1

## 9.2.0

### Minor Changes

- ebc320c78: Updated the UBTC config getter to sync it with the soneium extension

### Patch Changes

- Updated dependencies [7fe739d52]
- Updated dependencies [3e66e8f12]
- Updated dependencies [3852a9015]
  - @hyperlane-xyz/sdk@9.2.0
  - @hyperlane-xyz/helloworld@9.2.0
  - @hyperlane-xyz/utils@9.2.0

## 9.1.0

### Patch Changes

- Updated dependencies [67d91e489]
- Updated dependencies [cad82683f]
- Updated dependencies [97c773476]
- Updated dependencies [351bf0010]
- Updated dependencies [cad82683f]
  - @hyperlane-xyz/sdk@9.1.0
  - @hyperlane-xyz/helloworld@9.1.0
  - @hyperlane-xyz/utils@9.1.0

## 9.0.0

### Patch Changes

- Updated dependencies [0d8624d99]
- Updated dependencies [b07e2f2ea]
- Updated dependencies [4df37393f]
- Updated dependencies [88970a78c]
  - @hyperlane-xyz/sdk@9.0.0
  - @hyperlane-xyz/utils@9.0.0
  - @hyperlane-xyz/helloworld@9.0.0

## 8.9.0

### Minor Changes

- 768b601da: updated the warp monitor to monitor extra lock boxes
- 33178eaa8: Move getRegistry function from the CLI to `@hyperlane-xyz/registry` package.

### Patch Changes

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
  - @hyperlane-xyz/helloworld@8.9.0

## 8.8.1

### Patch Changes

- Updated dependencies [c68529807]
  - @hyperlane-xyz/cli@8.8.1
  - @hyperlane-xyz/helloworld@8.8.1
  - @hyperlane-xyz/sdk@8.8.1
  - @hyperlane-xyz/utils@8.8.1

## 8.8.0

### Patch Changes

- Updated dependencies [719d022ec]
- Updated dependencies [c61546cb7]
- Updated dependencies [d82d24cc7]
- Updated dependencies [b054b0424]
  - @hyperlane-xyz/sdk@8.8.0
  - @hyperlane-xyz/cli@8.8.0
  - @hyperlane-xyz/helloworld@8.8.0
  - @hyperlane-xyz/utils@8.8.0

## 8.7.0

### Minor Changes

- db832b803: Added support for multiple registries in CLI with prioritization.

### Patch Changes

- Updated dependencies [bd0b8861f]
- Updated dependencies [55db270e3]
- Updated dependencies [b92eb1b57]
- Updated dependencies [db832b803]
- Updated dependencies [ede0cbc15]
- Updated dependencies [12e3c4da0]
- Updated dependencies [d6724c4c3]
- Updated dependencies [7dd1f64a6]
- Updated dependencies [d93a38cab]
  - @hyperlane-xyz/sdk@8.7.0
  - @hyperlane-xyz/cli@8.7.0
  - @hyperlane-xyz/helloworld@8.7.0
  - @hyperlane-xyz/utils@8.7.0

## 8.6.1

### Patch Changes

- @hyperlane-xyz/helloworld@8.6.1
- @hyperlane-xyz/sdk@8.6.1
- @hyperlane-xyz/utils@8.6.1

## 8.6.0

### Patch Changes

- Updated dependencies [407d82004]
- Updated dependencies [ac984a17b]
- Updated dependencies [276d7ce4e]
- Updated dependencies [ba50e62fc]
- Updated dependencies [1e6ee0b9c]
- Updated dependencies [77946bb13]
  - @hyperlane-xyz/sdk@8.6.0
  - @hyperlane-xyz/helloworld@8.6.0
  - @hyperlane-xyz/utils@8.6.0

## 8.5.0

### Patch Changes

- Updated dependencies [55b8ccdff]
  - @hyperlane-xyz/sdk@8.5.0
  - @hyperlane-xyz/helloworld@8.5.0
  - @hyperlane-xyz/utils@8.5.0

## 8.4.0

### Patch Changes

- Updated dependencies [f6b682cdb]
  - @hyperlane-xyz/sdk@8.4.0
  - @hyperlane-xyz/helloworld@8.4.0
  - @hyperlane-xyz/utils@8.4.0

## 8.3.0

### Minor Changes

- fed42c325: updated zero ETH warp route config getter
- 31c89a3c1: Add support for Artela config

### Patch Changes

- Updated dependencies [7546c0181]
- Updated dependencies [49856fbb9]
  - @hyperlane-xyz/sdk@8.3.0
  - @hyperlane-xyz/helloworld@8.3.0
  - @hyperlane-xyz/utils@8.3.0

## 8.2.0

### Minor Changes

- 28becff74: Add Artela/Base USDC and WETH warp route config

### Patch Changes

- Updated dependencies [69a684869]
  - @hyperlane-xyz/sdk@8.2.0
  - @hyperlane-xyz/helloworld@8.2.0
  - @hyperlane-xyz/utils@8.2.0

## 8.1.0

### Minor Changes

- 2d4963c62: Add USDC between Ink and Ethereum
- fc80df5b4: Add rstETH/ethereum-zircuit warp config

### Patch Changes

- Updated dependencies [79c61c891]
- Updated dependencies [9518dbc84]
- Updated dependencies [9ab961a79]
  - @hyperlane-xyz/sdk@8.1.0
  - @hyperlane-xyz/helloworld@8.1.0
  - @hyperlane-xyz/utils@8.1.0

## 8.0.0

### Minor Changes

- fd20bb1e9: Add FeeHook and Swell to pz and ez eth config generator. Bump up Registry 6.6.0
- 0e83758f4: added ubtc route extension config + usdc from appchain to base

### Patch Changes

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
  - @hyperlane-xyz/helloworld@8.0.0
  - @hyperlane-xyz/sdk@8.0.0
  - @hyperlane-xyz/utils@8.0.0

## 7.3.0

### Minor Changes

- 1ca857451: add USDC, USDT, cbBTC and ETH zeronetwork warp routes support in infra
- 323f0f158: Add ICAs management in core apply command

### Patch Changes

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
  - @hyperlane-xyz/helloworld@7.3.0
  - @hyperlane-xyz/utils@7.3.0

## 7.2.0

### Patch Changes

- Updated dependencies [81ab4332f]
- Updated dependencies [4b3537470]
- Updated dependencies [fa6d5f5c6]
- Updated dependencies [fa6d5f5c6]
  - @hyperlane-xyz/sdk@7.2.0
  - @hyperlane-xyz/utils@7.2.0
  - @hyperlane-xyz/helloworld@7.2.0

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
  - @hyperlane-xyz/helloworld@7.1.0

## 7.0.0

### Minor Changes

- fa424826c: Add support for updating the mailbox proxy admin owner

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
  - @hyperlane-xyz/helloworld@7.0.0

## 6.0.0

### Patch Changes

- Updated dependencies [7b3b07900]
- Updated dependencies [30d92c319]
- Updated dependencies [e3b97c455]
  - @hyperlane-xyz/sdk@6.0.0
  - @hyperlane-xyz/utils@6.0.0
  - @hyperlane-xyz/helloworld@6.0.0

## 5.7.0

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
  - @hyperlane-xyz/helloworld@5.7.0

## 5.6.2

### Patch Changes

- Updated dependencies [5fd4267e7]
- Updated dependencies [a36fc5fb2]
  - @hyperlane-xyz/utils@5.6.2
  - @hyperlane-xyz/sdk@5.6.2
  - @hyperlane-xyz/helloworld@5.6.2

## 5.6.1

### Patch Changes

- @hyperlane-xyz/helloworld@5.6.1
- @hyperlane-xyz/sdk@5.6.1
- @hyperlane-xyz/utils@5.6.1

## 5.6.0

### Minor Changes

- b3495b205: Updates the warpIds for Renzo's latest deployment to Sei and Taiko to be used by the Checker
- c3e9268f1: Add support for an arbitrary string in `reorgPeriod`, which is used as a block tag to get the finalized block.

### Patch Changes

- Updated dependencies [f1712deb7]
- Updated dependencies [46044a2e9]
- Updated dependencies [02a5b92ba]
- Updated dependencies [29341950e]
- Updated dependencies [8001bbbd6]
- Updated dependencies [32d0a67c2]
- Updated dependencies [b1ff48bd1]
- Updated dependencies [e89f9e35d]
- Updated dependencies [d41aa6928]
- Updated dependencies [c3e9268f1]
- Updated dependencies [7d7bcc1a3]
- Updated dependencies [7f3e0669d]
- Updated dependencies [2317eca3c]
  - @hyperlane-xyz/utils@5.6.0
  - @hyperlane-xyz/sdk@5.6.0
  - @hyperlane-xyz/helloworld@5.6.0

## 5.5.0

### Patch Changes

- Updated dependencies [2afc484a2]
- Updated dependencies [2afc484a2]
- Updated dependencies [3254472e0]
- Updated dependencies [fcfe91113]
- Updated dependencies [6176c9861]
  - @hyperlane-xyz/sdk@5.5.0
  - @hyperlane-xyz/utils@5.5.0
  - @hyperlane-xyz/helloworld@5.5.0

## 5.4.0

### Patch Changes

- Updated dependencies [4415ac224]
  - @hyperlane-xyz/utils@5.4.0
  - @hyperlane-xyz/sdk@5.4.0
  - @hyperlane-xyz/helloworld@5.4.0

## 5.3.0

### Patch Changes

- Updated dependencies [eb47aaee8]
- Updated dependencies [50319d8ba]
- Updated dependencies [35d4503b9]
- Updated dependencies [8de531fa4]
- Updated dependencies [746eeb9d9]
- Updated dependencies [fd536a79a]
- Updated dependencies [50319d8ba]
  - @hyperlane-xyz/sdk@5.3.0
  - @hyperlane-xyz/helloworld@5.3.0
  - @hyperlane-xyz/utils@5.3.0

## 5.2.1

### Patch Changes

- @hyperlane-xyz/helloworld@5.2.1
- @hyperlane-xyz/sdk@5.2.1
- @hyperlane-xyz/utils@5.2.1

## 5.2.0

### Minor Changes

- 203084df2: Added sdk support for Stake weighted ISM

### Patch Changes

- 5a0d68bdc: replace import console module with direct console
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
  - @hyperlane-xyz/helloworld@5.2.0

## 5.1.0

### Minor Changes

- 013f19c64: Update to registry v2.5.0

### Patch Changes

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
- Updated dependencies [013f19c64]
- Updated dependencies [19f7d4fd9]
  - @hyperlane-xyz/sdk@5.1.0
  - @hyperlane-xyz/helloworld@5.1.0
  - @hyperlane-xyz/utils@5.1.0

## 5.0.0

### Minor Changes

- 388d25517: Added HyperlaneRelayer for relaying messages from the CLI

### Patch Changes

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
  - @hyperlane-xyz/helloworld@5.0.0

## 4.1.0

### Minor Changes

- d31677224: Deploy to bob, mantle, taiko

### Patch Changes

- Updated dependencies [36e75af4e]
- Updated dependencies [d31677224]
- Updated dependencies [4cc9327e5]
- Updated dependencies [1687fca93]
  - @hyperlane-xyz/sdk@4.1.0
  - @hyperlane-xyz/helloworld@4.1.0
  - @hyperlane-xyz/utils@4.1.0

## 4.0.0

### Minor Changes

- 6398aab72: Upgrade registry to 2.1.1
- bf7ad09da: feat(cli): add `warp --symbol` flag

### Patch Changes

- Updated dependencies [b05ae38ac]
- Updated dependencies [9304fe241]
- Updated dependencies [6398aab72]
- Updated dependencies [bdcbe1d16]
- Updated dependencies [6b63c5d82]
- Updated dependencies [bf7ad09da]
- Updated dependencies [e38d31685]
- Updated dependencies [e0f226806]
- Updated dependencies [6db9fa9ad]
  - @hyperlane-xyz/sdk@4.0.0
  - @hyperlane-xyz/helloworld@4.0.0
  - @hyperlane-xyz/utils@4.0.0

## 3.16.0

### Minor Changes

- 5cc64eb09: Add support for new chains: linea, fraxtal, sei.
  Support osmosis remote.
  Drive-by fix to always fetch explorer API keys when running deploy script.

### Patch Changes

- 5cc64eb09: Allow selecting a specific chain to govern in check-deploy script
- Updated dependencies [f9bbdde76]
- Updated dependencies [5cc64eb09]
  - @hyperlane-xyz/sdk@3.16.0
  - @hyperlane-xyz/helloworld@3.16.0
  - @hyperlane-xyz/utils@3.16.0

## 3.15.1

### Patch Changes

- Updated dependencies [6620fe636]
- Updated dependencies [acaa22cd9]
- Updated dependencies [921e449b4]
  - @hyperlane-xyz/helloworld@3.15.1
  - @hyperlane-xyz/sdk@3.15.1
  - @hyperlane-xyz/utils@3.15.1

## 3.15.0

### Patch Changes

- Updated dependencies [51bfff683]
  - @hyperlane-xyz/sdk@3.15.0
  - @hyperlane-xyz/helloworld@3.15.0
  - @hyperlane-xyz/utils@3.15.0

## 3.14.0

### Patch Changes

- @hyperlane-xyz/helloworld@3.14.0
- @hyperlane-xyz/sdk@3.14.0
- @hyperlane-xyz/utils@3.14.0

## 3.13.0

### Minor Changes

- 39ea7cdef: Implement multi collateral warp routes
- 0cf692e73: Implement metadata builder fetching from message

### Patch Changes

- b6b26e2bb: fix: minor change was breaking in registry export
- Updated dependencies [b6b26e2bb]
- Updated dependencies [39ea7cdef]
- Updated dependencies [babe816f8]
- Updated dependencies [0cf692e73]
  - @hyperlane-xyz/helloworld@3.13.0
  - @hyperlane-xyz/sdk@3.13.0
  - @hyperlane-xyz/utils@3.13.0

## 3.12.0

### Patch Changes

- Updated dependencies [eba393680]
- Updated dependencies [69de68a66]
  - @hyperlane-xyz/sdk@3.12.0
  - @hyperlane-xyz/utils@3.12.0
  - @hyperlane-xyz/helloworld@3.12.0

## 3.11.1

### Patch Changes

- Updated dependencies [c900da187]
  - @hyperlane-xyz/sdk@3.11.1
  - @hyperlane-xyz/helloworld@3.11.1
  - @hyperlane-xyz/utils@3.11.1

## 3.11.0

### Minor Changes

- af2634207: Moved Hook/ISM reading into CLI.

### Patch Changes

- a86a8296b: Removes Gnosis safe util from infra in favor of SDK
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
  - @hyperlane-xyz/helloworld@3.11.0
  - @hyperlane-xyz/utils@3.11.0

## 3.10.0

### Minor Changes

- 96485144a: SDK support for ICA deployment and operation.
- 38358ecec: Deprecate Polygon Mumbai testnet (soon to be replaced by Polygon Amoy testnet)
- 4e7a43be6: Replace Debug logger with Pino

### Patch Changes

- Updated dependencies [96485144a]
- Updated dependencies [38358ecec]
- Updated dependencies [ed0d4188c]
- Updated dependencies [4e7a43be6]
  - @hyperlane-xyz/helloworld@3.10.0
  - @hyperlane-xyz/utils@3.10.0
  - @hyperlane-xyz/sdk@3.10.0

## 3.9.0

### Patch Changes

- Updated dependencies [11f257ebc]
  - @hyperlane-xyz/sdk@3.9.0
  - @hyperlane-xyz/helloworld@3.9.0
  - @hyperlane-xyz/utils@3.9.0

## 3.8.2

### Patch Changes

- @hyperlane-xyz/helloworld@3.8.2
- @hyperlane-xyz/sdk@3.8.2
- @hyperlane-xyz/utils@3.8.2

## 3.8.1

### Patch Changes

- Updated dependencies [5daaae274]
  - @hyperlane-xyz/utils@3.8.1
  - @hyperlane-xyz/sdk@3.8.1
  - @hyperlane-xyz/helloworld@3.8.1

## 3.8.0

### Minor Changes

- 9681df08d: Remove support for goerli networks (including optimismgoerli, arbitrumgoerli, lineagoerli and polygonzkevmtestnet)
- 9681df08d: Enabled verification of contracts as part of the deployment flow.

  - Solidity build artifact is now included as part of the `@hyperlane-xyz/core` package.
  - Updated the `HyperlaneDeployer` to perform contract verification immediately after deploying a contract. A default verifier is instantiated using the core build artifact.
  - Updated the `HyperlaneIsmFactory` to re-use the `HyperlaneDeployer` for deployment where possible.
  - Minor logging improvements throughout deployers.

### Patch Changes

- 9681df08d: Removed basegoerli and moonbasealpha testnets
- 9681df08d: Add logos for plume to SDK
- 9681df08d: TestRecipient as part of core deployer
- 9681df08d: Update viction validator set
- 9681df08d: Patch transfer ownership in hook deployer
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
  - @hyperlane-xyz/helloworld@3.8.0
  - @hyperlane-xyz/utils@3.8.0

## 3.7.0

### Minor Changes

- 54aeb6420: Added warp route artifacts type adopting registry schema

### Patch Changes

- 87151c62b: Bumped injective reorg period
- ab17af5f7: Updating HyperlaneIgpDeployer to configure storage gas oracles as part of deployment
- Updated dependencies [6f464eaed]
- Updated dependencies [87151c62b]
- Updated dependencies [ab17af5f7]
- Updated dependencies [7b40232af]
- Updated dependencies [54aeb6420]
  - @hyperlane-xyz/sdk@3.7.0
  - @hyperlane-xyz/helloworld@3.7.0
  - @hyperlane-xyz/utils@3.7.0

## 3.6.2

### Patch Changes

- @hyperlane-xyz/helloworld@3.6.2
- @hyperlane-xyz/sdk@3.6.2
- @hyperlane-xyz/utils@3.6.2

## 3.6.1

### Patch Changes

- ae4476ad0: Bumped mantapacific reorgPeriod to 1, a reorg period in chain metadata is now required by infra.
- e4e4f93fc: Support pausable ISM in deployer and checker
- Updated dependencies [3c298d064]
- Updated dependencies [ae4476ad0]
- Updated dependencies [f3b7ddb69]
- Updated dependencies [df24eec8b]
- Updated dependencies [78e50e7da]
- Updated dependencies [e4e4f93fc]
  - @hyperlane-xyz/utils@3.6.1
  - @hyperlane-xyz/sdk@3.6.1
  - @hyperlane-xyz/helloworld@3.6.1

## 3.6.0

### Patch Changes

- 67a6d971e: Added `shouldRecover` flag to deployContractFromFactory so that the `TestRecipientDeployer` can deploy new contracts if it's not the owner of the prior deployments (We were recovering the SDK artifacts which meant the deployer won't be able to set the ISM as they needed)
- Updated dependencies [67a6d971e]
- Updated dependencies [612d4163a]
- Updated dependencies [0488ef31d]
- Updated dependencies [8d8ba3f7a]
  - @hyperlane-xyz/sdk@3.6.0
  - @hyperlane-xyz/helloworld@3.6.0
  - @hyperlane-xyz/utils@3.6.0

## 3.5.1

### Patch Changes

- Updated dependencies [a04454d6d]
  - @hyperlane-xyz/sdk@3.5.1
  - @hyperlane-xyz/helloworld@3.5.1
  - @hyperlane-xyz/utils@3.5.1

## 3.5.0

### Minor Changes

- 655b6a0cd: Redeploy Routing ISM Factories

### Patch Changes

- f7d285e3a: Adds Test Recipient addresses to the SDK artifacts
- Updated dependencies [655b6a0cd]
- Updated dependencies [08ba0d32b]
- Updated dependencies [f7d285e3a]
  - @hyperlane-xyz/sdk@3.5.0
  - @hyperlane-xyz/helloworld@3.5.0
  - @hyperlane-xyz/utils@3.5.0

## 3.4.0

### Patch Changes

- e06fe0b32: Supporting DefaultFallbackRoutingIsm through non-factory deployments
- Updated dependencies [7919417ec]
- Updated dependencies [fd4fc1898]
- Updated dependencies [e06fe0b32]
- Updated dependencies [b832e57ae]
- Updated dependencies [79c96d718]
  - @hyperlane-xyz/sdk@3.4.0
  - @hyperlane-xyz/utils@3.4.0
  - @hyperlane-xyz/helloworld@3.4.0

## 3.3.0

### Patch Changes

- 7e620c9df: Allow CLI to accept hook as a config
- 9f2c7ce7c: Removing agentStartBlocks and using mailbox.deployedBlock() instead
- Updated dependencies [7e620c9df]
- Updated dependencies [350175581]
- Updated dependencies [9f2c7ce7c]
  - @hyperlane-xyz/sdk@3.3.0
  - @hyperlane-xyz/helloworld@3.3.0
  - @hyperlane-xyz/utils@3.3.0

## 3.2.0

### Patch Changes

- Updated dependencies [df693708b]
  - @hyperlane-xyz/sdk@3.2.0
  - @hyperlane-xyz/helloworld@3.2.0
  - @hyperlane-xyz/utils@3.2.0

## 3.1.10

### Patch Changes

- Updated dependencies [c9e0aedae]
  - @hyperlane-xyz/helloworld@3.1.10
  - @hyperlane-xyz/sdk@3.1.10
  - @hyperlane-xyz/utils@3.1.10
