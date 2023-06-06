// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IMessageHook {
    function postDispatch(uint32 _destination, bytes32 _messageId)
        external
        payable
        returns (uint256);
}
