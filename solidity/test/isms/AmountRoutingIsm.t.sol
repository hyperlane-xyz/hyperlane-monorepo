// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TestIsm} from "../../contracts/test/TestIsm.sol";
import {AmountRoutingIsm} from "../../contracts/isms/warp-route/AmountRoutingIsm.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";

contract AmountRoutingIsmTest is Test {
    using TokenMessage for bytes;
    using TypeCasts for address;

    AmountRoutingIsm internal ism;
    uint8 internal constant DECIMALS = 18;

    TestIsm internal lower;
    TestIsm internal upper;

    uint256 threshold = type(uint256).max / 2;

    function setUp() public virtual {
        lower = new TestIsm();
        upper = new TestIsm();
        ism = new AmountRoutingIsm(address(lower), address(upper), threshold);
    }

    function testWarp(
        uint32 localDomain,
        uint32 remoteDomain,
        uint256 amount
    ) public {
        vm.assume(localDomain != remoteDomain);

        MockMailbox localMailbox = new MockMailbox(localDomain);
        MockMailbox remoteMailbox = new MockMailbox(remoteDomain);
        remoteMailbox.addRemoteMailbox(localDomain, localMailbox);

        HypERC20 localWarpRoute = new HypERC20(DECIMALS, address(localMailbox));
        HypERC20 remoteWarpRoute = new HypERC20(
            DECIMALS,
            address(remoteMailbox)
        );
        remoteWarpRoute.initialize(
            amount, // mint some tokens
            "",
            "",
            address(0),
            address(0),
            address(this)
        );
        remoteWarpRoute.enrollRemoteRouter(
            localDomain,
            address(localWarpRoute).addressToBytes32()
        );
        localWarpRoute.enrollRemoteRouter(
            remoteDomain,
            address(remoteWarpRoute).addressToBytes32()
        );

        localWarpRoute.setInterchainSecurityModule(address(ism));

        remoteWarpRoute.transferRemote(
            localDomain,
            address(this).addressToBytes32(),
            amount
        );

        if (amount >= threshold) {
            vm.expectCall(address(upper), bytes(""));
        } else {
            vm.expectCall(address(lower), bytes(""));
        }
        localMailbox.processNextInboundMessage();
    }

    function testRoute(
        bytes32 recipient,
        uint256 amount,
        bytes calldata data
    ) public {
        bytes memory headers = Message.formatMessage(
            uint8(0),
            uint32(0),
            uint32(0),
            bytes32(0),
            uint32(0),
            bytes32(0),
            bytes(data[0:0])
        );

        bytes memory body = TokenMessage.format(recipient, amount, data[0:0]);
        bytes memory message = abi.encodePacked(headers, body);

        IInterchainSecurityModule route = ism.route(message);
        if (amount >= threshold) {
            assertEq(address(route), address(upper));
        } else {
            assertEq(address(route), address(lower));
        }
    }
}
