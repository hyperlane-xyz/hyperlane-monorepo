// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract TestHook is IPostDispatchHook {
    uint256 public fee = 0;

    event TestPostDispatch(bytes metadata, bytes message);

    function setFee(uint256 _fee) external {
        fee = _fee;
    }

    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable
    {
        emit TestPostDispatch(metadata, message);
    }

    function quoteDispatch(bytes calldata, bytes calldata)
        external
        view
        returns (uint256)
    {
        return fee;
    }
}
