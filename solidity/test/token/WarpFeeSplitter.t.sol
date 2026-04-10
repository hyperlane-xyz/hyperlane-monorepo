// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {WarpFeeSplitter} from "../../contracts/token/fees/WarpFeeSplitter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockLpRouter {
    using SafeERC20 for IERC20;

    address public immutable token;
    uint256 public totalDonations;

    constructor(address _token) {
        token = _token;
    }

    function donate(uint256 amount) external payable {
        if (token == address(0)) {
            require(msg.value == amount, "MockLpRouter: bad value");
        } else {
            require(msg.value == 0, "MockLpRouter: unexpected value");
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
        totalDonations += amount;
    }
}

contract WarpFeeSplitterTest is Test {
    uint256 internal constant STREAMING_PERIOD = 10 days;

    address internal owner = address(0xA11CE);
    address internal protocolBeneficiary = address(0xCAFE);

    ERC20Test internal token;
    MockLpRouter internal lpRouter;
    WarpFeeSplitter internal splitter;

    function setUp() public {
        token = new ERC20Test("Test Token", "TST", 0, 18);
        lpRouter = new MockLpRouter(address(token));
        splitter = new WarpFeeSplitter(
            owner,
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD
        );
    }

    function testConstructorRejectsBadConfig() public {
        vm.expectRevert(bytes("WarpFeeSplitter: owner zero"));
        new WarpFeeSplitter(
            address(0),
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD
        );

        vm.expectRevert(bytes("WarpFeeSplitter: hub router zero"));
        new WarpFeeSplitter(
            owner,
            address(0),
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD
        );

        vm.expectRevert(bytes("WarpFeeSplitter: beneficiary zero"));
        new WarpFeeSplitter(
            owner,
            address(lpRouter),
            2_500,
            address(0),
            STREAMING_PERIOD
        );

        vm.expectRevert(bytes("WarpFeeSplitter: lp bps too high"));
        new WarpFeeSplitter(
            owner,
            address(lpRouter),
            10_001,
            protocolBeneficiary,
            STREAMING_PERIOD
        );

        vm.expectRevert(bytes("WarpFeeSplitter: streaming period zero"));
        new WarpFeeSplitter(
            owner,
            address(lpRouter),
            2_500,
            protocolBeneficiary,
            0
        );
    }

    function testNotifyRejectsNoNewFees() public {
        vm.expectRevert(bytes("WarpFeeSplitter: no new fees"));
        splitter.notify(address(token));
    }

    function testNotifySplitsAndStreamsErc20Fees() public {
        token.mintTo(address(splitter), 10_000);

        splitter.notify(address(token));

        (uint256 remaining, uint256 lastUpdated, uint256 end) = splitter
            .streams(address(token));
        assertEq(remaining, 2_500);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp + STREAMING_PERIOD);
        assertEq(lpRouter.totalDonations(), 0);
        assertEq(token.balanceOf(address(lpRouter)), 0);
        assertEq(token.balanceOf(protocolBeneficiary), 7_500);
        assertEq(token.balanceOf(address(splitter)), 2_500);

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        assertEq(splitter.previewDrip(address(token)), 1_250);
        splitter.drip(address(token));

        (remaining, lastUpdated, end) = splitter.streams(address(token));
        assertEq(remaining, 1_250);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, STREAMING_PERIOD + 1);
        assertEq(lpRouter.totalDonations(), 1_250);
        assertEq(token.balanceOf(address(lpRouter)), 1_250);
        assertEq(token.balanceOf(address(splitter)), 1_250);

        vm.warp(block.timestamp + STREAMING_PERIOD);
        assertEq(splitter.previewDrip(address(token)), 1_250);
        splitter.drip(address(token));

        (remaining, lastUpdated, end) = splitter.streams(address(token));
        assertEq(remaining, 0);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp);
        assertEq(lpRouter.totalDonations(), 2_500);
        assertEq(token.balanceOf(address(lpRouter)), 2_500);
        assertEq(token.balanceOf(address(splitter)), 0);
    }

    function testNotifyAddsNewFeesToStream() public {
        token.mintTo(address(splitter), 10_000);
        splitter.notify(address(token));

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        token.mintTo(address(splitter), 10_000);
        splitter.notify(address(token));

        (uint256 remaining, uint256 lastUpdated, uint256 end) = splitter
            .streams(address(token));
        assertEq(remaining, 3_750);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp + STREAMING_PERIOD);
        assertEq(lpRouter.totalDonations(), 1_250);
        assertEq(token.balanceOf(protocolBeneficiary), 15_000);
    }

    function testNotifyStreamsNativeFees() public {
        MockLpRouter nativeLpRouter = new MockLpRouter(address(0));
        vm.prank(owner);
        splitter.setHubRouter(address(nativeLpRouter));
        vm.deal(address(splitter), 10_000);

        splitter.notify(address(0));

        (uint256 remaining, , ) = splitter.streams(address(0));
        assertEq(remaining, 2_500);
        assertEq(address(splitter).balance, 2_500);
        assertEq(protocolBeneficiary.balance, 7_500);

        vm.warp(block.timestamp + STREAMING_PERIOD);
        splitter.drip(address(0));

        assertEq(nativeLpRouter.totalDonations(), 2_500);
        assertEq(address(nativeLpRouter).balance, 2_500);
        assertEq(address(splitter).balance, 0);
    }

    function testOwnerSetters() public {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        splitter.setLpBps(1);

        vm.startPrank(owner);
        vm.expectRevert(bytes("WarpFeeSplitter: hub router zero"));
        splitter.setHubRouter(address(0));
        vm.expectRevert(bytes("WarpFeeSplitter: lp bps too high"));
        splitter.setLpBps(10_001);
        vm.expectRevert(bytes("WarpFeeSplitter: beneficiary zero"));
        splitter.setProtocolBeneficiary(address(0));
        vm.expectRevert(bytes("WarpFeeSplitter: streaming period zero"));
        splitter.setStreamingPeriod(0);

        splitter.setLpBps(5_000);
        splitter.setProtocolBeneficiary(address(0xDAD));
        splitter.setStreamingPeriod(1 days);
        splitter.setHubRouter(address(0xFACADE));
        vm.stopPrank();

        assertEq(splitter.lpBps(), 5_000);
        assertEq(splitter.protocolBeneficiary(), address(0xDAD));
        assertEq(splitter.streamingPeriod(), 1 days);
        assertEq(splitter.hubRouter(), address(0xFACADE));
    }
}
