// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {AbstractPostDispatchHook} from "../hooks/libs/AbstractPostDispatchHook.sol";

contract TestPostDispatchHook is AbstractPostDispatchHook {
    // ============ Public Storage ============

    // test fees for quoteDispatch
    uint256 public fee = 0;

    function supportsMetadata(bytes calldata)
        public
        pure
        override
        returns (bool)
    {
        return true;
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    // ============ Internal functions ============
    function _postDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) internal pure override {
        // test - empty
    }

    function _quoteDispatch(
        bytes calldata,
        /*metadata*/
        bytes calldata /*message*/
    ) internal view override returns (uint256) {
        return fee;
    }
}
