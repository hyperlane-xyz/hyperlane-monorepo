// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {MockInbox} from "./MockInbox.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockOutbox {
    MockInbox inbox;
    using TypeCasts for address;

    constructor(address _inbox) {
        inbox = MockInbox(_inbox);
    }

    function dispatch(
        uint32,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external {
        inbox.addPendingMessage(
            msg.sender.addressToBytes32(),
            _recipientAddress,
            _messageBody
        );
    }
}
