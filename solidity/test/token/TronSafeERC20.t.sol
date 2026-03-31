// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20Harness, TronUSDTMock, FalseReturningERC20Mock} from "../../contracts/test/TronSafeERC20Test.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";

contract TronSafeERC20Test is Test {
    // Must match the constant in overrides/tron/SafeERC20.sol
    address constant TRON_USDT = 0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C;

    SafeERC20Harness harness;

    function setUp() public {
        harness = new SafeERC20Harness();
    }

    // -- safeTransfer: Tron USDT (returns false on success) --

    function test_safeTransfer_tronUSDT_succeeds() public {
        // Deploy mock at the exact Tron USDT address
        TronUSDTMock mock = new TronUSDTMock();
        vm.etch(TRON_USDT, address(mock).code);

        TronUSDTMock tronUsdt = TronUSDTMock(TRON_USDT);
        tronUsdt.mint(address(harness), 100e6);

        // Should succeed despite transfer() returning false
        harness.safeTransfer(IERC20(TRON_USDT), address(this), 50e6);
        assertEq(tronUsdt.balanceOf(address(this)), 50e6);
    }

    function test_safeTransfer_tronUSDT_revertsOnFailure() public {
        TronUSDTMock mock = new TronUSDTMock();
        vm.etch(TRON_USDT, address(mock).code);

        // Don't fund the harness — transfer should revert
        vm.expectRevert("SafeERC20: ERC20 transfer failed");
        harness.safeTransfer(IERC20(TRON_USDT), address(this), 50e6);
    }

    // -- safeTransfer: normal ERC20 (returns true) --

    function test_safeTransfer_normalERC20_succeeds() public {
        ERC20Test token = new ERC20Test("Test", "TST", 1000e18, 18);
        token.transfer(address(harness), 100e18);

        harness.safeTransfer(IERC20(address(token)), address(this), 50e18);
        assertEq(token.balanceOf(address(this)), 950e18);
    }

    // -- safeTransfer: false-returning ERC20 at non-USDT address --

    function test_safeTransfer_falseReturningERC20_reverts() public {
        FalseReturningERC20Mock token = new FalseReturningERC20Mock();
        token.mint(address(harness), 100e18);

        // Non-USDT token returning false should revert via _callOptionalReturn
        vm.expectRevert("SafeERC20: ERC20 operation did not succeed");
        harness.safeTransfer(IERC20(address(token)), address(this), 50e18);
    }
}
