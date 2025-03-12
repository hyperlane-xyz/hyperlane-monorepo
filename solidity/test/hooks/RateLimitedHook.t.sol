// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {Message} from "contracts/libs/Message.sol";
import {TokenMessage} from "contracts/token/libs/TokenMessage.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";

import {RateLimitedHook} from "contracts/hooks/warp-route/RateLimitedHook.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {HypERC20} from "contracts/token/HypERC20.sol";

import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

contract RateLimitedHookTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant MAX_CAPACITY = 1 ether;
    uint256 constant ONE_PERCENT = 0.01 ether;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    address constant BOB = address(0x2);

    TestMailbox localMailbox;
    TestMailbox remoteMailbox;
    ERC20Test token;
    TestPostDispatchHook internal noopHook;

    RateLimitedHook rateLimitedHook;
    HypERC20Collateral warpRouteLocal;
    HypERC20 warpRouteRemote;

    function _mintAndApprove(uint256 amount) internal {
        token.mint(amount);
        token.approve(address(warpRouteLocal), amount);
    }

    function setUp() external {
        localMailbox = new TestMailbox(ORIGIN);
        remoteMailbox = new TestMailbox(DESTINATION);

        token = new ERC20Test("Test", "Test", 100 ether, 18);
        noopHook = new TestPostDispatchHook();

        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));

        warpRouteLocal = new HypERC20Collateral(
            address(token),
            SCALE,
            address(localMailbox)
        );

        rateLimitedHook = new RateLimitedHook(
            address(localMailbox),
            MAX_CAPACITY,
            address(warpRouteLocal)
        );

        warpRouteLocal.initialize(
            address(rateLimitedHook),
            address(0),
            address(this)
        );

        warpRouteRemote = new HypERC20(DECIMALS, SCALE, address(remoteMailbox));

        warpRouteLocal.enrollRemoteRouter(
            DESTINATION,
            address(warpRouteRemote).addressToBytes32()
        );

        warpRouteRemote.enrollRemoteRouter(
            ORIGIN,
            address(warpRouteLocal).addressToBytes32()
        );
    }

    function testRateLimitedHook_revertsIfInvalidSender() external {
        vm.expectRevert("InvalidSender");
        new RateLimitedHook(address(localMailbox), MAX_CAPACITY, address(0));
    }

    function testRateLimitedHook_revertsIfCalledByNonMailbox(
        bytes calldata _message
    ) external {
        vm.prank(address(warpRouteLocal));
        bytes memory testMessage = localMailbox.buildOutboundMessage(
            DESTINATION,
            address(warpRouteRemote).addressToBytes32(),
            TokenMessage.format(BOB.addressToBytes32(), 1 ether, _message)
        );

        vm.expectRevert("InvalidDispatchedMessage");
        rateLimitedHook.postDispatch(bytes(""), testMessage);
    }

    function testRateLimitedHook_revertsIfNonAuthorizedSender(
        bytes calldata _message
    ) external {
        bytes memory testMessage = localMailbox.buildOutboundMessage(
            DESTINATION,
            address(warpRouteRemote).addressToBytes32(),
            TokenMessage.format(
                BOB.addressToBytes32(),
                1 ether,
                bytes("hello world")
            )
        );

        vm.expectRevert("InvalidSender");
        rateLimitedHook.postDispatch(bytes(""), testMessage);
    }

    function testRateLimitedHook_revertsTransfer_ifExceedsFilledLevel(
        uint128 _amount,
        uint128 _time
    ) external {
        // Warp to a random time, get it's filled level, and try to transfer more than the target max
        vm.warp(_time);
        uint256 filledLevelBefore = rateLimitedHook.calculateCurrentLevel();
        vm.assume(_amount > filledLevelBefore);
        _mintAndApprove(_amount);

        vm.expectRevert("RateLimitExceeded");
        warpRouteLocal.transferRemote{value: 1}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
    }

    function testRateLimitedHook_allowsTransfer_ifUnderLimit(
        uint128 _amount,
        uint128 _time
    ) external {
        // Warp to a random time, get it's filled level, and try to transfer less than the target max
        vm.warp(_time);
        uint256 filledLevelBefore = rateLimitedHook.calculateCurrentLevel();
        vm.assume(_amount <= filledLevelBefore);

        _mintAndApprove(_amount);
        warpRouteLocal.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
        uint256 limitAfter = rateLimitedHook.calculateCurrentLevel();
        assertApproxEqRel(limitAfter, filledLevelBefore - _amount, ONE_PERCENT);
    }

    function testRateLimitedHook_preventsDuplicateMessageFromValidating(
        uint128 _amount
    ) public {
        // Warp to a random time, get it's filled level, and try to transfer less than the target max
        vm.warp(1 days);
        uint256 filledLevelBefore = rateLimitedHook.calculateCurrentLevel();
        vm.assume(_amount <= filledLevelBefore);

        _mintAndApprove(_amount);

        // Generate an outbound message that will be the same as the one created in transferRemote
        bytes memory tokenMessage = TokenMessage.format(
            BOB.addressToBytes32(),
            _amount,
            bytes("")
        );
        vm.prank(address(warpRouteLocal));
        bytes memory message = localMailbox.buildOutboundMessage(
            DESTINATION,
            address(warpRouteRemote).addressToBytes32(),
            tokenMessage
        );

        bytes32 messageId = warpRouteLocal.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );

        assertEq(message.id(), messageId);

        vm.expectRevert("MessageAlreadyValidated");
        rateLimitedHook.postDispatch(bytes(""), message);
    }
}
