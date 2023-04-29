// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IMessageHook {
    function postDispatch(uint32 destination, bytes32 messageId)
        external
        returns (uint256);
}
