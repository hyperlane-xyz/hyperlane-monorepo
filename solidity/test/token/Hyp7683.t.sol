// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;
import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";

import {Hyp7683} from "../../contracts/token/extensions/Hyp7683.sol";
import {MockHyperlaneEnvironment} from "../../contracts/mock/MockHyperlaneEnvironment.sol";
import {InterchainAccountIsm} from "../../contracts/isms/routing/InterchainAccountIsm.sol";
import {CallLib, OwnableMulticall, InterchainAccountRouter} from "../../contracts/middleware/InterchainAccountRouter.sol";
import {InterchainAccountRouterTestBase} from "../InterchainAccountRouter.t.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";

contract Hyp7683Test is InterchainAccountRouterTestBase {
    using TypeCasts for address;

    Hyp7683 internal originRouter;
    Hyp7683 internal destinationRouter;

    ERC20Test internal originToken;
    ERC20Test internal destinationToken;

    uint8 internal constant DECIMALS = 18;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    string internal constant NAME = "HyperlaneInu";
    string internal constant SYMBOL = "HYP";
    uint256 fastFee = 5e15;

    address swapper = address(0x1);
    address filler = address(0x2);

    function setUp() public override {
        super.setUp();
        originToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);
        destinationToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);
        originToken.mintTo(swapper, 100e18);
        destinationToken.mintTo(filler, 100e18);

        originRouter = new Hyp7683(
            address(originToken),
            address(environment.mailboxes(origin)),
            fastFee
        );

        destinationRouter = new Hyp7683(
            address(destinationToken),
            address(environment.mailboxes(destination)),
            fastFee
        );

        originRouter.initialize(
            0,
            NAME,
            SYMBOL,
            address(0x0),
            address(0x0),
            address(this)
        );
        destinationRouter.initialize(
            0,
            NAME,
            SYMBOL,
            address(0x0),
            address(0x0),
            address(this)
        );

        originRouter.enrollRemoteRouter(
            destination,
            address(destinationRouter).addressToBytes32()
        );
        destinationRouter.enrollRemoteRouter(
            origin,
            address(originRouter).addressToBytes32()
        );
    }

    function testWithoutFiller() public {
        vm.startPrank(swapper);
        uint256 amount = 1e18;
        originToken.approve(address(originRouter), amount);
        originRouter.transferRemote(
            destination,
            swapper.addressToBytes32(),
            amount
        );

        // expect revert since nobody filled
        vm.expectRevert();
        environment.processNextPendingMessage();

        // have collateral in there
        destinationToken.mintTo(address(destinationRouter), amount);
        environment.processNextPendingMessage();
    }

    function testWithFiller() public {
        vm.startPrank(swapper);
        uint256 amount = 1e18;
        originToken.approve(address(originRouter), amount);
        originRouter.transferRemote(
            destination,
            swapper.addressToBytes32(),
            amount
        );

        // filler fills
        vm.startPrank(filler);
        destinationToken.approve(address(destinationRouter), amount);
        destinationRouter.fillFastTransfer(swapper, amount, origin, 1);
        assertEq(destinationToken.balanceOf(swapper), amount - fastFee);
        assertEq(destinationRouter.balanceOf(filler), 0);

        // synthetic should be minted after transaction completes
        environment.processNextPendingMessage();
        assertEq(destinationRouter.balanceOf(filler), amount);

        // synthetic can be redeemed on the origin chain()
        assertEq(originToken.balanceOf(filler), 0);
        destinationRouter.transferRemoteSettle(
            origin,
            filler.addressToBytes32(),
            amount
        );
        environment.processNextPendingMessageFromDestination();
        assertEq(originToken.balanceOf(filler), amount);
    }
}
