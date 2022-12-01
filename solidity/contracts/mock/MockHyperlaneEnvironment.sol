// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "./MockMailbox.sol";
import "../middleware/InterchainQueryRouter.sol";
import "../InterchainGasPaymaster.sol";
import "../test/TestIsm.sol";

import {TypeCasts} from "../libs/TypeCasts.sol";

contract MockHyperlaneEnvironment {
    uint32 originDomain;
    uint32 destinationDomain;

    mapping(uint32 => MockMailbox) public mailboxes;
    mapping(uint32 => InterchainGasPaymaster) public igps;
    mapping(uint32 => IInterchainSecurityModule) public isms;
    mapping(uint32 => InterchainQueryRouter) public queryRouters;

    constructor(uint32 _originDomain, uint32 _destinationDomain) {
        originDomain = _originDomain;
        destinationDomain = _destinationDomain;

        MockMailbox originMailbox = new MockMailbox(_originDomain);
        MockMailbox destinationMailbox = new MockMailbox(_destinationDomain);

        originMailbox.addRemoteMailbox(_destinationDomain, destinationMailbox);
        destinationMailbox.addRemoteMailbox(_originDomain, originMailbox);

        igps[originDomain] = new InterchainGasPaymaster();
        igps[destinationDomain] = new InterchainGasPaymaster();

        isms[originDomain] = new TestIsm();
        isms[destinationDomain] = new TestIsm();

        mailboxes[_originDomain] = originMailbox;
        mailboxes[_destinationDomain] = destinationMailbox;

        InterchainQueryRouter originQueryRouter = new InterchainQueryRouter();
        InterchainQueryRouter destinationQueryRouter = new InterchainQueryRouter();

        originQueryRouter.initialize(
            address(this),
            address(originMailbox),
            address(igps[originDomain])
        );
        destinationQueryRouter.initialize(
            address(this),
            address(destinationMailbox),
            address(igps[destinationDomain])
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

    function processNextPendingMessage() public {
        mailboxes[destinationDomain].processNextInboundMessage();
    }

    function processNextPendingMessageFromDestination() public {
        mailboxes[originDomain].processNextInboundMessage();
    }
}
