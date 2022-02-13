// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.7.6;

import "ds-test/test.sol";

import "./Dapptools.sol";
import "@celo-org/optics-sol/contracts/test/TestHome.sol";
import "@celo-org/optics-sol/contracts/test/TestReplica.sol";
import {XAppConnectionManager, TypeCasts} from "@celo-org/optics-sol/contracts/XAppConnectionManager.sol";

contract MockOpticsDeployment {

    uint32 senderDomain = 1;
    uint32 recipientDomain = 2;

    MockHome home;
    MockReplica replica;

    XAppConnectionManager senderXAppConnectionManager;
    XAppConnectionManager recipientXAppConnectionMnaager;

    function setupMockDeployment() internal {
        home = new MockHome(senderDomain);
        replica = new MockReplica(recipientDomain);
        home.addReplica(recipientDomain, address(replica));
        senderXAppConnectionManager = new XAppConnectionManager();
        senderXAppConnectionManager.setHome(address(home));
        recipientXAppConnectionMnaager = new XAppConnectionManager();
        recipientXAppConnectionMnaager.ownerEnrollReplica(address(replica), senderDomain);
    }
}

contract HandleCallRecorder {
    uint32 public origin;
    bytes32 public sender;
    bytes public messageBody;

    function handle(uint32 _origin, bytes32 _sender, bytes memory _messageBody) public {
        origin = _origin;
        sender = _sender;
        messageBody = _messageBody;
    }
}

contract DapptoolsTest is DSTest, MockOpticsDeployment {
    Dapptools dapptools;

    function setUp() public {
        dapptools = new Dapptools();
        setupMockDeployment();
    }

    function testMessageSend(bytes memory body) public {
        HandleCallRecorder recorder = new HandleCallRecorder();
        home.dispatch(recipientDomain, TypeCasts.addressToBytes32(address(recorder)), body);
        replica.flushMessages();
        assertEq(uint(recorder.origin()), uint(senderDomain), "Test");
    }

    function testFail_basic_sanity() public {
        assertTrue(false);
    }

    function test_basic_sanity() public {
        assertTrue(true);
    }
}
