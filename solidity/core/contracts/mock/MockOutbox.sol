// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {MockInbox} from "./MockInbox.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockOutbox {
    MockInbox inbox;
    uint32 domain;
    using TypeCasts for address;

    constructor(uint32 _domain, address _inbox) {
        domain = _domain;
        inbox = MockInbox(_inbox);
    }

    function dispatch(
        uint32,
        bytes32 _recipientAddress,
        bytes calldata _messageBody
    ) external returns (uint256) {
        inbox.addPendingMessage(
            domain,
            msg.sender.addressToBytes32(),
            _recipientAddress,
            _messageBody
        );
        return 1;
    }
}
