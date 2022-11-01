// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "../contracts/mock/MockOutbox.sol";
import "../contracts/mock/MockInbox.sol";
import "../contracts/AbacusConnectionManager.sol";

contract HyperlaneTestEnvironment {
    MockOutbox public outbox;
    MockInbox public inbox;

    mapping(uint32 => AbacusConnectionManager) connectionManagers;

    constructor(uint32 _originDomain, uint32 _destinationDomain) {
        inbox = new MockInbox();
        outbox = new MockOutbox(_originDomain, address(inbox));

        AbacusConnectionManager originManager = new AbacusConnectionManager();
        AbacusConnectionManager destinationManager = new AbacusConnectionManager();

        originManager.setOutbox(address(outbox));
        destinationManager.enrollInbox(_destinationDomain, address(inbox));

        connectionManagers[_originDomain] = originManager;
        connectionManagers[_destinationDomain] = destinationManager;
    }

    function connectionManager(uint32 _domain)
        public
        view
        returns (AbacusConnectionManager)
    {
        return connectionManagers[_domain];
    }

    function processNextPendingMessage() public {
        inbox.processNextPendingMessage();
    }
}
