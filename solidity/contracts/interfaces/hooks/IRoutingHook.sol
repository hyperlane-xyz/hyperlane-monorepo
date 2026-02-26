// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {IPostDispatchHook} from "./IPostDispatchHook.sol";

interface IRoutingHook {
    function hooks(
        uint32 destination
    ) external returns (IPostDispatchHook hook);
}
