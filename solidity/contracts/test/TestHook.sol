// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract TestHook is IPostDispatchHook {
    event TestPostDispatch(bytes metadata, bytes message);

    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable
    {
        emit TestPostDispatch(metadata, message);
    }

    function quoteDispatch(bytes calldata, bytes calldata)
        external
        pure
        returns (uint256)
    {
        return 0;
    }
}
