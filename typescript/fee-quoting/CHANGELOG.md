# @hyperlane-xyz/fee-quoting

## 27.3.0

### Minor Changes

- 262073e: The SVM quote service was changed to substitute the user-supplied `recipient` with `WILDCARD_RECIPIENT` (`0xff × 32`) when signing standing-mode warp quotes — transient mode is unchanged. SVM standing quotes are stored at a PDA keyed by `(fee_account, dest_domain, target_router)` with no recipient in the seeds, so signing the user's actual recipient partitioned the standing PDA per recipient and prevented reuse. The on-chain consume handler already has a wildcard-recipient fallback (fee program `processor/quote.rs`) that accepts the substituted value, so standing quotes became universally consumable as designed. EVM behavior is unchanged — EVM quotes are recipient-bound by the wrapper contract's exec-time verification, not by a PDA lookup, so the substitution doesn't apply there.

### Patch Changes

- Updated dependencies [92909f8]
- Updated dependencies [262073e]
- Updated dependencies [df34a68]
- Updated dependencies [262073e]
- Updated dependencies [af8e1f6]
- Updated dependencies [cc4bdb6]
- Updated dependencies [c7895b6]
- Updated dependencies [262073e]
- Updated dependencies [6e803be]
- Updated dependencies [cb0c7c9]
- Updated dependencies [a82c918]
- Updated dependencies [262073e]
- Updated dependencies [351cf01]
- Updated dependencies [5122e71]
- Updated dependencies [262073e]
- Updated dependencies [262073e]
- Updated dependencies [262073e]
- Updated dependencies [262073e]
- Updated dependencies [c4b3ff5]
- Updated dependencies [31f8b51]
- Updated dependencies [97e8ca1]
- Updated dependencies [955281d]
- Updated dependencies [5122e71]
- Updated dependencies [9c8b435]
  - @hyperlane-xyz/sdk@37.0.0
  - @hyperlane-xyz/sealevel-sdk@37.0.0
  - @hyperlane-xyz/provider-sdk@7.1.0
  - @hyperlane-xyz/utils@37.0.0

## 27.2.19

### Patch Changes

- Updated dependencies [d288e7b]
- Updated dependencies [d288e7b]
- Updated dependencies [d288e7b]
- Updated dependencies [019201a]
- Updated dependencies [cc722b8]
- Updated dependencies [9cd7606]
- Updated dependencies [2821252]
- Updated dependencies [a6a3a33]
- Updated dependencies [2821252]
- Updated dependencies [d288e7b]
- Updated dependencies [d288e7b]
- Updated dependencies [aa41ce4]
- Updated dependencies [2f9d783]
- Updated dependencies [9bdab1d]
- Updated dependencies [d288e7b]
- Updated dependencies [cf6857e]
- Updated dependencies [32b87ad]
- Updated dependencies [cf6857e]
  - @hyperlane-xyz/sdk@36.0.0
  - @hyperlane-xyz/utils@36.0.0

## 27.2.18

### Patch Changes

- Updated dependencies [88e51ed]
- Updated dependencies [fb63f5f]
- Updated dependencies [889c68a]
- Updated dependencies [fb63f5f]
- Updated dependencies [92ef474]
- Updated dependencies [f0b325a]
- Updated dependencies [6db4aee]
- Updated dependencies [babb3d0]
- Updated dependencies [867ce3c]
- Updated dependencies [b77faf4]
- Updated dependencies [fb63f5f]
- Updated dependencies [fb63f5f]
  - @hyperlane-xyz/sdk@35.2.0
  - @hyperlane-xyz/utils@35.2.0

## 27.2.17

### Patch Changes

- Updated dependencies [830ce1d]
- Updated dependencies [9cdf9eb]
  - @hyperlane-xyz/sdk@35.1.0
  - @hyperlane-xyz/utils@35.1.0

## 27.2.16

### Patch Changes

- Updated dependencies [06a5b6b]
- Updated dependencies [da1cfb1]
- Updated dependencies [4bb1c3e]
- Updated dependencies [93c2290]
  - @hyperlane-xyz/sdk@35.0.1
  - @hyperlane-xyz/utils@35.0.1

## 27.2.15

### Patch Changes

- Updated dependencies [38479d0]
- Updated dependencies [4adf279]
- Updated dependencies [7089676]
- Updated dependencies [44aa432]
- Updated dependencies [631d7e7]
- Updated dependencies [6c687ee]
- Updated dependencies [a8c9430]
  - @hyperlane-xyz/sdk@35.0.0
  - @hyperlane-xyz/utils@35.0.0

## 27.2.14

### Patch Changes

- Updated dependencies [9a1ce26]
- Updated dependencies [f758a70]
- Updated dependencies [2151352]
- Updated dependencies [b8a600c]
  - @hyperlane-xyz/sdk@34.0.0
  - @hyperlane-xyz/utils@34.0.0

## 27.2.13

### Patch Changes

- Updated dependencies [9ad1bd0]
- Updated dependencies [530f02e]
- Updated dependencies [9670e43]
- Updated dependencies [cc90a8f]
  - @hyperlane-xyz/sdk@33.1.1
  - @hyperlane-xyz/utils@33.1.1

## 27.2.12

### Patch Changes

- Updated dependencies [6f4b790]
- Updated dependencies [bfe4d2e]
- Updated dependencies [6929388]
- Updated dependencies [47649b7]
- Updated dependencies [0b1c1d1]
- Updated dependencies [d9dec53]
  - @hyperlane-xyz/sdk@33.1.0
  - @hyperlane-xyz/utils@33.1.0

## 27.2.11

### Patch Changes

- Updated dependencies [1f918d0]
- Updated dependencies [78199f4]
  - @hyperlane-xyz/sdk@33.0.2
  - @hyperlane-xyz/utils@33.0.2

## 27.2.10

### Patch Changes

- Updated dependencies [a2081df]
- Updated dependencies [4c91737]
  - @hyperlane-xyz/sdk@33.0.1
  - @hyperlane-xyz/utils@33.0.1

## 27.2.9

### Patch Changes

- Updated dependencies [dc8e560]
  - @hyperlane-xyz/sdk@33.0.0
  - @hyperlane-xyz/utils@33.0.0

## 27.2.8

### Patch Changes

- Updated dependencies [611b911]
- Updated dependencies [c6de4c9]
  - @hyperlane-xyz/sdk@32.0.1
  - @hyperlane-xyz/utils@32.0.1

## 27.2.7

### Patch Changes

- Updated dependencies [e4da110]
- Updated dependencies [d588eb5]
- Updated dependencies [ab17263]
- Updated dependencies [ebde778]
  - @hyperlane-xyz/sdk@32.0.0
  - @hyperlane-xyz/utils@32.0.0

## 27.2.6

### Patch Changes

- Updated dependencies [f9c8f83]
  - @hyperlane-xyz/sdk@31.2.1
  - @hyperlane-xyz/utils@31.2.1

## 27.2.5

### Patch Changes

- Updated dependencies [35fb5c8]
  - @hyperlane-xyz/sdk@31.2.0
  - @hyperlane-xyz/utils@31.2.0

## 27.2.4

### Patch Changes

- Updated dependencies [8a082af]
- Updated dependencies [c8fe242]
- Updated dependencies [8a082af]
  - @hyperlane-xyz/sdk@31.1.0
  - @hyperlane-xyz/utils@31.1.0

## 27.2.3

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/sdk@31.0.1

## 27.2.2

### Patch Changes

- Updated dependencies [44626fb]
- Updated dependencies [df33d41]
- Updated dependencies [4963b32]
- Updated dependencies [9003721]
- Updated dependencies [69e6b3f]
- Updated dependencies [fc0a1cf]
  - @hyperlane-xyz/sdk@31.0.0
  - @hyperlane-xyz/utils@31.0.0

## 27.2.1

### Patch Changes

- Updated dependencies [26d682b]
  - @hyperlane-xyz/sdk@30.1.1
  - @hyperlane-xyz/utils@30.1.1

## 27.2.0

### Minor Changes

- e1f35a7: The offchain fee quoting service and client were added, with CLI integration for quoted transfers and SDK export of DEFAULT_ROUTER_KEY.

### Patch Changes

- Updated dependencies [4c4462f]
- Updated dependencies [71f0ca4]
- Updated dependencies [9061916]
- Updated dependencies [2057d1a]
- Updated dependencies [e1f35a7]
- Updated dependencies [b691b87]
- Updated dependencies [6f8c503]
- Updated dependencies [5eae48e]
- Updated dependencies [57e46b1]
  - @hyperlane-xyz/sdk@30.1.0
  - @hyperlane-xyz/utils@30.1.0
