// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

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
}
