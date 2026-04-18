// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {WarpFeeVault} from "../../contracts/token/fees/WarpFeeVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

contract MockLpRouter is ERC4626 {
    constructor(IERC20 _asset) ERC4626(_asset) ERC20("Router LP", "rLP") {}
}

contract WarpFeeVaultTest is Test {
    uint256 internal constant STREAMING_PERIOD = 10 days;

    address internal owner = address(0xA11CE);
    address internal protocolBeneficiary = address(0xCAFE);
    address internal alice = address(0xA11);
    address internal bob = address(0xB0B);
    address internal charlie = address(0xC0FFEE);

    ERC20Test internal token;
    MockLpRouter internal lpRouter;
    WarpFeeVault internal vault;

    function setUp() public {
        token = new ERC20Test("Test Token", "TST", 0, 18);
        lpRouter = new MockLpRouter(IERC20(address(token)));
        vault = new WarpFeeVault(
            owner,
            IERC20(address(token)),
            lpRouter,
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );
    }

    function testConstructorRevertsForInvalidConfig() public {
        uint256 bpsScale = vault.BPS_SCALE();

        vm.expectRevert("WarpFeeVault: owner zero");
        new WarpFeeVault(
            address(0),
            IERC20(address(token)),
            lpRouter,
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );

        vm.expectRevert("WarpFeeVault: asset zero");
        new WarpFeeVault(
            owner,
            IERC20(address(0)),
            lpRouter,
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );

        vm.expectRevert("WarpFeeVault: router zero");
        new WarpFeeVault(
            owner,
            IERC20(address(token)),
            IERC4626(address(0)),
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );

        ERC20Test otherToken = new ERC20Test("Other Token", "OTH", 0, 18);
        MockLpRouter otherRouter = new MockLpRouter(
            IERC20(address(otherToken))
        );
        vm.expectRevert("WarpFeeVault: asset mismatch");
        new WarpFeeVault(
            owner,
            IERC20(address(token)),
            otherRouter,
            2_500,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );

        vm.expectRevert("WarpFeeVault: beneficiary zero");
        new WarpFeeVault(
            owner,
            IERC20(address(token)),
            lpRouter,
            2_500,
            address(0),
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );

        vm.expectRevert("WarpFeeVault: lp bps too high");
        new WarpFeeVault(
            owner,
            IERC20(address(token)),
            lpRouter,
            bpsScale + 1,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );

        vm.expectRevert("WarpFeeVault: streaming period zero");
        new WarpFeeVault(
            owner,
            IERC20(address(token)),
            lpRouter,
            2_500,
            protocolBeneficiary,
            0,
            "Warp Fee Vault",
            "WFV"
        );
    }

    function testOwnerCanSetAdminConfig() public {
        vm.startPrank(owner);
        vault.setLpBps(5_000);
        vault.setProtocolBeneficiary(charlie);
        vault.setStreamingPeriod(5 days);
        vm.stopPrank();

        assertEq(vault.lpBps(), 5_000);
        assertEq(vault.protocolBeneficiary(), charlie);
        assertEq(vault.streamingPeriod(), 5 days);
    }

    function testAdminConfigReverts() public {
        uint256 bpsScale = vault.BPS_SCALE();

        vm.expectRevert("Ownable: caller is not the owner");
        vault.setLpBps(5_000);

        vm.expectRevert("Ownable: caller is not the owner");
        vault.setProtocolBeneficiary(charlie);

        vm.expectRevert("Ownable: caller is not the owner");
        vault.setStreamingPeriod(5 days);

        vm.startPrank(owner);
        vm.expectRevert("WarpFeeVault: lp bps too high");
        vault.setLpBps(bpsScale + 1);

        vm.expectRevert("WarpFeeVault: beneficiary zero");
        vault.setProtocolBeneficiary(address(0));

        vm.expectRevert("WarpFeeVault: streaming period zero");
        vault.setStreamingPeriod(0);
        vm.stopPrank();
    }

    function testDepositAndWithdrawUseRouterPosition() public {
        token.mintTo(alice, 10_000);

        vm.startPrank(alice);
        token.approve(address(vault), 10_000);
        uint256 shares = vault.deposit(10_000, alice);
        assertEq(shares, 10_000 * 10 ** vault.DECIMALS_OFFSET());
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.totalAssets(), 10_000);
        assertEq(lpRouter.balanceOf(address(vault)), 10_000);
        assertEq(token.balanceOf(address(lpRouter)), 10_000);

        vault.withdraw(4_000, alice, alice);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 6_000 * 10 ** vault.DECIMALS_OFFSET());
        assertEq(vault.totalAssets(), 6_000);
        assertEq(token.balanceOf(alice), 4_000);
        assertEq(token.balanceOf(address(lpRouter)), 6_000);
    }

    function testMintAndRedeemUseRouterPosition() public {
        uint256 shares = 10_000 * 10 ** vault.DECIMALS_OFFSET();
        token.mintTo(alice, 10_000);

        vm.startPrank(alice);
        token.approve(address(vault), 10_000);
        uint256 assets = vault.mint(shares, alice);
        assertEq(assets, 10_000);
        assertEq(vault.balanceOf(alice), shares);

        uint256 redeemedAssets = vault.redeem(shares / 2, alice, alice);
        vm.stopPrank();

        assertEq(redeemedAssets, 5_000);
        assertEq(vault.balanceOf(alice), shares / 2);
        assertEq(vault.totalAssets(), 5_000);
        assertEq(token.balanceOf(alice), 5_000);
    }

    function testNotifyRevertsWhenNoFeesSwept() public {
        vm.expectRevert("WarpFeeVault: no new fees");
        vault.notify();
    }

    function testNotifyRevertsWhenBalanceBelowStream() public {
        token.mintTo(address(vault), 10_000);
        vault.notify();
        vm.prank(address(vault));
        token.transfer(charlie, 1);

        vm.expectRevert("WarpFeeVault: balance below stream");
        vault.notify();
    }

    function testNotifyWithZeroLpBpsSendsAllFeesToProtocol() public {
        WarpFeeVault zeroLpVault = new WarpFeeVault(
            owner,
            IERC20(address(token)),
            lpRouter,
            0,
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );
        token.mintTo(address(zeroLpVault), 10_000);

        zeroLpVault.notify();

        (uint256 remaining, , , ) = zeroLpVault.stream();
        assertEq(remaining, 0);
        assertEq(token.balanceOf(protocolBeneficiary), 10_000);
        assertEq(token.balanceOf(address(zeroLpVault)), 0);
    }

    function testNotifyWithFullLpBpsStreamsAllFeesToLps() public {
        WarpFeeVault fullLpVault = new WarpFeeVault(
            owner,
            IERC20(address(token)),
            lpRouter,
            vault.BPS_SCALE(),
            protocolBeneficiary,
            STREAMING_PERIOD,
            "Warp Fee Vault",
            "WFV"
        );
        token.mintTo(address(fullLpVault), 10_000);

        fullLpVault.notify();

        (uint256 remaining, , uint256 lastUpdated, uint256 end) = fullLpVault
            .stream();
        assertEq(remaining, 10_000);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp + STREAMING_PERIOD);
        assertEq(token.balanceOf(protocolBeneficiary), 0);
        assertEq(token.balanceOf(address(fullLpVault)), 10_000);
    }

    function testNotifySplitsAndStreamsFeesInTotalAssets() public {
        _deposit(alice, 10_000);
        token.mintTo(address(vault), 10_000);

        vault.notify();

        (
            uint256 remaining,
            uint256 recognized,
            uint256 lastUpdated,
            uint256 end
        ) = vault.stream();
        assertEq(remaining, 2_500);
        assertEq(recognized, 0);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp + STREAMING_PERIOD);
        assertEq(vault.totalAssets(), 10_000);
        assertEq(lpRouter.totalAssets(), 10_000);
        assertEq(token.balanceOf(protocolBeneficiary), 7_500);
        assertEq(token.balanceOf(address(vault)), 2_500);

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        assertEq(vault.previewSettle(), 1_250);
        assertEq(vault.totalAssets(), 11_250);
        assertEq(lpRouter.totalAssets(), 10_000);

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        assertEq(vault.previewSettle(), 2_500);
        assertEq(vault.totalAssets(), 12_500);
        assertEq(lpRouter.totalAssets(), 10_000);
    }

    function testDepositSettlesVestedFeesBeforeMinting() public {
        _deposit(alice, 10_000);
        token.mintTo(address(vault), 10_000);
        vault.notify();

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        uint256 previewShares = vault.previewDeposit(10_000);
        assertEq(previewShares, 8_888_987_645);

        token.mintTo(bob, 10_000);
        vm.startPrank(bob);
        token.approve(address(vault), 10_000);
        uint256 shares = vault.deposit(10_000, bob);
        vm.stopPrank();

        (
            uint256 remaining,
            uint256 recognized,
            uint256 lastUpdated,
            uint256 end
        ) = vault.stream();
        assertEq(shares, previewShares);
        assertEq(remaining, 1_250);
        assertEq(recognized, 1_250);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, STREAMING_PERIOD + 1);
        assertEq(lpRouter.totalAssets(), 20_000);
        assertEq(token.balanceOf(address(vault)), 2_500);
        assertEq(vault.totalAssets(), 21_250);
    }

    function testWithdrawSettlesVestedFeesSoAssetsArePayable() public {
        _deposit(alice, 10_000);
        token.mintTo(address(vault), 10_000);
        vault.notify();

        vm.warp(block.timestamp + STREAMING_PERIOD);
        uint256 maxWithdraw = vault.maxWithdraw(alice);
        assertEq(maxWithdraw, 12_499);
        assertEq(lpRouter.totalAssets(), 10_000);

        vm.prank(alice);
        vault.withdraw(maxWithdraw, alice, alice);

        (
            uint256 remaining,
            uint256 recognized,
            uint256 lastUpdated,
            uint256 end
        ) = vault.stream();
        assertEq(remaining, 0);
        assertEq(recognized, 0);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp);
        assertEq(token.balanceOf(alice), maxWithdraw);
        assertEq(lpRouter.totalAssets(), 1);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.totalAssets(), 1);
    }

    function testApprovedSpenderCanWithdraw() public {
        _deposit(alice, 10_000);
        uint256 shares = vault.previewWithdraw(4_000);

        vm.prank(alice);
        vault.approve(bob, shares);

        vm.prank(bob);
        vault.withdraw(4_000, bob, alice);

        assertEq(
            vault.balanceOf(alice),
            10_000 * 10 ** vault.DECIMALS_OFFSET() - shares
        );
        assertEq(vault.allowance(alice, bob), 0);
        assertEq(token.balanceOf(bob), 4_000);
        assertEq(vault.totalAssets(), 6_000);
    }

    function testNotifyAddsNewFeesToStream() public {
        token.mintTo(address(vault), 10_000);
        vault.notify();

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        token.mintTo(address(vault), 10_000);
        vault.notify();

        (
            uint256 remaining,
            uint256 recognized,
            uint256 lastUpdated,
            uint256 end
        ) = vault.stream();
        assertEq(remaining, 3_750);
        assertEq(recognized, 1_250);
        assertEq(lastUpdated, block.timestamp);
        assertEq(end, block.timestamp + 720000);
        assertEq(lpRouter.totalAssets(), 0);
        assertEq(token.balanceOf(protocolBeneficiary), 15_000);
    }

    function testDustNotifyBarelyExtendsExistingStream() public {
        token.mintTo(address(vault), 10_000);
        vault.notify();

        vm.warp(block.timestamp + STREAMING_PERIOD / 2);
        token.mintTo(address(vault), 4);
        vault.notify();

        (
            uint256 remaining,
            uint256 recognized,
            uint256 lastUpdated,
            uint256 end
        ) = vault.stream();
        assertEq(remaining, 1_251);
        assertEq(recognized, 1_250);
        assertEq(lastUpdated, block.timestamp);
        assertLe(end, block.timestamp + (STREAMING_PERIOD / 2) + 347);
        assertEq(token.balanceOf(protocolBeneficiary), 7_503);
    }

    function testStreamDoesNotLeakToDirectRouterLp() public {
        _deposit(alice, 10_000);

        token.mintTo(charlie, 10_000);
        vm.startPrank(charlie);
        token.approve(address(lpRouter), 10_000);
        lpRouter.deposit(10_000, charlie);
        vm.stopPrank();

        uint256 charlieMaxWithdrawBefore = lpRouter.maxWithdraw(charlie);

        token.mintTo(address(vault), 10_000);
        vault.notify();
        vm.warp(block.timestamp + STREAMING_PERIOD);

        assertEq(lpRouter.totalAssets(), 20_000);
        assertEq(lpRouter.maxWithdraw(charlie), charlieMaxWithdrawBefore);
        assertEq(vault.totalAssets(), 12_500);
    }

    function _deposit(address account, uint256 amount) internal {
        token.mintTo(account, amount);
        vm.startPrank(account);
        token.approve(address(vault), amount);
        vault.deposit(amount, account);
        vm.stopPrank();
    }
}
