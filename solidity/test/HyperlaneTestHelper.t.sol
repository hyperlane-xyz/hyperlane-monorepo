// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "../contracts/mock/MockOutbox.sol";
import "../contracts/mock/MockInbox.sol";
import "../contracts/AbacusConnectionManager.sol";

contract HyperlaneTestHelper {
    MockOutbox outbox;
    MockInbox inbox;

    AbacusConnectionManager originManager;
    AbacusConnectionManager destinationManager;

    // Must be explicitly called by tests that inherit from this contract
    function hyperlaneTestHelperSetUp(
        uint32 _originDomain,
        uint32 _destinationDomain
    ) internal {
        inbox = new MockInbox();
        outbox = new MockOutbox(_originDomain, address(inbox));

        originManager = new AbacusConnectionManager();
        destinationManager = new AbacusConnectionManager();

        originManager.setOutbox(address(outbox));
        destinationManager.enrollInbox(_destinationDomain, address(inbox));
    }
}
