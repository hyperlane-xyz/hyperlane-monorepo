// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractPostDispatchHook} from "../hooks/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/hooks/StandardHookMetadata.sol";

contract TestPostDispatchHook is AbstractPostDispatchHook {
    using StandardHookMetadata for bytes;

    // ============ Public Storage ============

    // test fees for quoteDispatch
    uint256 public fee = 0;

    // ============ Internal functions ============
    function _postDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) internal pure override {
        // test - empty
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function _quoteDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) internal view override returns (uint256) {
        return fee;
    }
}
