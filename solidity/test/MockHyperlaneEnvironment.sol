// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "../contracts/mock/MockOutbox.sol";
import "../contracts/mock/MockInbox.sol";
import "../contracts/AbacusConnectionManager.sol";
import "../contracts/middleware/InterchainQueryRouter.sol";

import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract MockHyperlaneEnvironment {
    MockOutbox public originOutbox;
    MockInbox public originInbox;

    MockOutbox public destinationOutbox;
    MockInbox public destinationInbox;

    mapping(uint32 => AbacusConnectionManager) public connectionManagers;
    mapping(uint32 => InterchainQueryRouter) public queryRouters;

    constructor(uint32 _originDomain, uint32 _destinationDomain) {
        originInbox = new MockInbox();
        originOutbox = new MockOutbox(_originDomain, address(originInbox));

        destinationInbox = new MockInbox();
        destinationOutbox = new MockOutbox(
            _destinationDomain,
            address(destinationInbox)
        );

        AbacusConnectionManager originManager = new AbacusConnectionManager();
        AbacusConnectionManager destinationManager = new AbacusConnectionManager();

        originManager.setOutbox(address(originOutbox));
        destinationManager.enrollInbox(
            _destinationDomain,
            address(originInbox)
        );
        destinationManager.setOutbox(address(destinationOutbox));
        originManager.enrollInbox(_originDomain, address(destinationInbox));

        connectionManagers[_originDomain] = originManager;
        connectionManagers[_destinationDomain] = destinationManager;

        InterchainQueryRouter originQueryRouter = new InterchainQueryRouter();
        InterchainQueryRouter destinationQueryRouter = new InterchainQueryRouter();

        originQueryRouter.initialize(
            address(this),
            address(originManager),
            address(0)
        );
        destinationQueryRouter.initialize(
            address(this),
            address(destinationManager),
            address(0)
        );

        originQueryRouter.enrollRemoteRouter(
            _destinationDomain,
            TypeCasts.addressToBytes32(address(destinationQueryRouter))
        );
        destinationQueryRouter.enrollRemoteRouter(
            _originDomain,
            TypeCasts.addressToBytes32(address(originQueryRouter))
        );

        queryRouters[_originDomain] = originQueryRouter;
        queryRouters[_destinationDomain] = destinationQueryRouter;
    }

    function connectionManager(uint32 _domain)
        public
        view
        returns (AbacusConnectionManager)
    {
        return connectionManagers[_domain];
    }

    function processNextPendingMessage() public {
        originInbox.processNextPendingMessage();
    }

    function processNextPendingMessageFromDestination() public {
        destinationInbox.processNextPendingMessage();
    }
}
