// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IPostDispatchHook {
    function postDispatch(bytes calldata metadata, bytes calldata message)
        external
        payable;
}
