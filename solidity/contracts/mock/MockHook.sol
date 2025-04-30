// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

/// @notice Mock implementation of a Post Dispatch Hook.
contract MockHook is IPostDispatchHook {
    function postDispatch(
        bytes calldata _metadata,
        bytes calldata _message
    ) external payable override {
        // Mock hook does nothing
    }

    function quoteDispatch(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view override returns (uint256) {
        // Mock hook requires no payment
        return 0;
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external view override returns (uint8) {
        return 0;
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata /*_metadata*/
    ) external view override returns (bool) {
        return true; // Mock hook supports any metadata
    }
}
