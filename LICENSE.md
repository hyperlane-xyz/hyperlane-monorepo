# Licenses

This repository contains code under multiple licenses.
Each source file indicates its license via an SPDX-License-Identifier header.

## Apache License 2.0 / MIT

Core protocol contracts, interfaces, base libraries, agents, SDK, and
utilities are licensed under Apache-2.0 (or MIT OR Apache-2.0 for some files).

See `LICENSE-APACHE-2.0` for the full Apache 2.0 license text.

## Business Source License 1.1

Commercial and product code including advanced token contracts, middleware,
infrastructure tooling, and CLI are licensed under BUSL-1.1.

See `LICENSE-BUSL-1.1` for the full license text including the
Additional Use Grant and Change Date.

## Directory Breakdown

### Apache 2.0 (or MIT OR Apache-2.0)
- `solidity/contracts/Mailbox.sol`
- `solidity/contracts/interfaces/` (all)
- `solidity/contracts/libs/`
- `solidity/contracts/client/`
- `solidity/contracts/isms/`
- `solidity/contracts/hooks/`
- `solidity/contracts/upgrade/`
- `solidity/contracts/PackageVersioned.sol`
- `solidity/contracts/token/HypERC20.sol`
- `solidity/contracts/token/HypERC20Collateral.sol`
- `solidity/contracts/token/HypERC721.sol`
- `solidity/contracts/token/HypERC721Collateral.sol`
- `solidity/contracts/token/HypNative.sol`
- `solidity/contracts/token/libs/TokenRouter.sol`
- `solidity/contracts/token/libs/TokenMessage.sol`
- `rust/`
- `typescript/sdk/`
- `typescript/utils/`

### BUSL-1.1
- `solidity/contracts/token/TokenBridgeCctpBase.sol`
- `solidity/contracts/token/TokenBridgeCctpV1.sol`
- `solidity/contracts/token/TokenBridgeCctpV2.sol`
- `solidity/contracts/token/extensions/` (all)
- `solidity/contracts/token/libs/` (all files EXCEPT TokenRouter.sol and TokenMessage.sol)
- `solidity/contracts/middleware/` (all)
- `typescript/infra/`
- `typescript/cli/`
