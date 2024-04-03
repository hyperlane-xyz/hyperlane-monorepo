// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;
import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {RateLimited} from "contracts/libs/RateLimited.sol";

import {RateLimitedHook} from "contracts/hooks/warp-route/RateLimitedHook.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {HypERC20} from "contracts/token/HypERC20.sol";

import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {ERC20Test} from "contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";

contract RateLimitedHookTest is Test {
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant ROUTE_LIMIT_AMOUNT = 1 ether;
    uint256 constant ONE_PERCENT = 0.01 ether;
    uint8 internal constant DECIMALS = 18;
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
        rateLimitedHook = new RateLimitedHook(address(localMailbox));

        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));

        warpRouteLocal = new HypERC20Collateral(
            address(token),
            address(localMailbox)
        );

        warpRouteLocal.initialize(
            address(rateLimitedHook),
            address(0),
            address(this)
        );

        warpRouteRemote = new HypERC20(DECIMALS, address(remoteMailbox));

        warpRouteLocal.enrollRemoteRouter(
            DESTINATION,
            address(warpRouteRemote).addressToBytes32()
        );

        warpRouteRemote.enrollRemoteRouter(
            ORIGIN,
            address(warpRouteLocal).addressToBytes32()
        );

        rateLimitedHook.setTargetLimit(
            address(warpRouteLocal),
            ROUTE_LIMIT_AMOUNT
        );
    }

    function testRateLimitedHook_revertsIfCalledByNonMailbox(
        bytes calldata _message
    ) external {
        vm.expectRevert("InvalidDispatchedMessage");
        rateLimitedHook.postDispatch(bytes(""), _message);
    }

    function testRateLimitedHook_revertsIfRateLimitExceeded(
        uint128 _amount,
        uint128 _time
    ) external {
        // Warp to a random time, get it's limit, and try to transfer more than the target max
        vm.warp(_time);
        uint256 targetLimitBefore = rateLimitedHook.getTargetLimit(
            address(warpRouteLocal)
        );
        vm.assume(_amount > targetLimitBefore);
        _mintAndApprove(_amount);

        vm.expectRevert(
            abi.encodeWithSelector(
                RateLimited.RateLimitExceeded.selector,
                _amount,
                targetLimitBefore
            )
        );
        warpRouteLocal.transferRemote{value: 1}(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
    }

    function testRateLimitedHook_allowsTransferUnderLimit(
        uint128 _amount,
        uint128 _time
    ) external {
        // Warp to a random time, get it's limit, and try to transfer less than the target max
        vm.warp(_time);
        uint256 targetLimitBefore = rateLimitedHook.getTargetLimit(
            address(warpRouteLocal)
        );
        vm.assume(_amount <= targetLimitBefore);

        _mintAndApprove(_amount);
        warpRouteLocal.transferRemote(
            DESTINATION,
            BOB.addressToBytes32(),
            _amount
        );
        uint256 limitAfter = rateLimitedHook.getCurrentLimit(
            address(warpRouteLocal)
        );
        assertApproxEqRel(limitAfter, targetLimitBefore - _amount, ONE_PERCENT);
    }
}
