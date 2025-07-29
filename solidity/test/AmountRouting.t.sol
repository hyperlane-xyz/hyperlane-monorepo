// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TestIsm} from "../contracts/test/TestIsm.sol";
import {TestPostDispatchHook} from "../contracts/test/TestPostDispatchHook.sol";
import {AmountRoutingIsm} from "../contracts/isms/warp-route/AmountRoutingIsm.sol";
import {AmountRoutingHook} from "../contracts/hooks/routing/AmountRoutingHook.sol";
import {IPostDispatchHook} from "../contracts/interfaces/hooks/IPostDispatchHook.sol";

import {TokenMessage} from "../contracts/token/libs/TokenMessage.sol";
import {Message} from "../contracts/libs/Message.sol";
import {IInterchainSecurityModule} from "../contracts/interfaces/IInterchainSecurityModule.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../contracts/mock/MockMailbox.sol";
import {HypERC20} from "../contracts/token/HypERC20.sol";

contract AmountRoutingTest is Test {
    using TokenMessage for bytes;
    using TypeCasts for address;

    AmountRoutingIsm internal ism;
    AmountRoutingHook internal hook;

    uint8 internal constant DECIMALS = 18;

    uint256 internal constant SCALE = 1;

    TestIsm internal lowerIsm;
    TestIsm internal upperIsm;

    TestPostDispatchHook internal lowerHook;
    TestPostDispatchHook internal upperHook;

    uint256 internal lowerFee = 1;
    uint256 internal upperFee = 2;

    uint256 threshold = type(uint256).max / 2;

    function setUp() public virtual {
        lowerIsm = new TestIsm();
        upperIsm = new TestIsm();
        ism = new AmountRoutingIsm(
            address(lowerIsm),
            address(upperIsm),
            threshold
        );
        lowerHook = new TestPostDispatchHook();
        upperHook = new TestPostDispatchHook();
        lowerHook.setFee(lowerFee);
        upperHook.setFee(upperFee);
        hook = new AmountRoutingHook(
            address(lowerHook),
            address(upperHook),
            threshold
        );
    }

    function test_warp(
        uint32 localDomain,
        uint32 remoteDomain,
        uint256 amount
    ) public {
        vm.assume(localDomain != remoteDomain);

        MockMailbox localMailbox = new MockMailbox(localDomain);
        MockMailbox remoteMailbox = new MockMailbox(remoteDomain);
        remoteMailbox.addRemoteMailbox(localDomain, localMailbox);

        HypERC20 localWarpRoute = new HypERC20(
            DECIMALS,
            SCALE,
            address(localMailbox)
        );
        localWarpRoute.initialize(
            0,
            "",
            "",
            address(hook),
            address(ism),
            address(this)
        );
        HypERC20 remoteWarpRoute = new HypERC20(
            DECIMALS,
            SCALE,
            address(remoteMailbox)
        );
        remoteWarpRoute.initialize(
            amount, // mint some tokens
            "",
            "",
            address(hook),
            address(ism),
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

        uint256 fee = remoteWarpRoute
        .quoteTransferRemote(
            localDomain,
            address(this).addressToBytes32(),
            amount
        )[0].amount;

        uint256 balanceBefore = address(this).balance;

        if (amount >= threshold) {
            assertEq(fee, upperFee);
            vm.expectCall(address(upperHook), upperFee, bytes(""));
        } else {
            assertEq(fee, lowerFee);
            vm.expectCall(address(lowerHook), lowerFee, bytes(""));
        }
        remoteWarpRoute.transferRemote{value: fee}(
            localDomain,
            address(this).addressToBytes32(),
            amount
        );

        if (amount >= threshold) {
            vm.expectCall(address(upperIsm), bytes(""));
        } else {
            // assert refund
            assertEq(balanceBefore - address(this).balance, lowerFee);
            vm.expectCall(address(lowerIsm), bytes(""));
        }
        localMailbox.processNextInboundMessage();
    }

    // for receiving refunds
    receive() external payable {}

    function test_hookType() public view {
        assertEq(
            hook.hookType(),
            uint8(IPostDispatchHook.Types.AMOUNT_ROUTING)
        );
    }

    function test_quoteDispatch(
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

        uint256 quote = hook.quoteDispatch(bytes(""), message);
        if (amount >= threshold) {
            assertEq(quote, upperFee);
        } else {
            assertEq(quote, lowerFee);
        }
    }

    function test_route(
        bytes32 recipient,
        uint256 amount,
        bytes calldata data
    ) public view {
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
            assertEq(address(route), address(upperIsm));
        } else {
            assertEq(address(route), address(lowerIsm));
        }
    }
}
