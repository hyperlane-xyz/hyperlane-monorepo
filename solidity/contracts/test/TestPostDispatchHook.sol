// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract TestPostDispatchHook is IPostDispatchHook {
    uint256 public fee = 25000;

    function postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata /*message*/
    ) external payable {
        // test - empty
    }

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function quoteDispatch(
        bytes calldata, /*metadata*/
        bytes calldata /*message*/
    ) external view override returns (uint256) {
        return fee;
    }
}
