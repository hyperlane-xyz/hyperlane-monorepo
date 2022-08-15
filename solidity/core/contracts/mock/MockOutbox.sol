// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {MockInbox} from "./MockInbox.sol";

contract MockOutbox {
    MockInbox inbox;

    constructor(address _inbox) {
        inbox = MockInbox(_inbox);
    }

    function dispatch(
        uint32,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external {
        inbox.addPendingMessage(
            addressToBytes32(msg.sender),
            _recipientAddress,
            _messageBody
        );
    }

    function addressToBytes32(address _addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_addr)));
    }
}
