// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ICoreBridge} from "wormhole-sdk/interfaces/ICoreBridge.sol";

/// @notice EVM-specific extension implemented by Wormhole Core deployments.
/// @dev The v1.1.0 Solidity SDK omits this deployed getter.
interface IEvmCoreBridge is ICoreBridge {
    function evmChainId() external view returns (uint256);
}
