// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

contract TestPostDispatchHook is IPostDispatchHook {
    event PostDispatchHookCalled();

    function postDispatch(
        bytes calldata, /*metadata*/
        bytes calldata /*message*/
    ) external payable override {
        // test - emit event
        emit PostDispatchHookCalled();
    }
}
