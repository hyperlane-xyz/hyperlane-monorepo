// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridge} from "contracts/interfaces/ITokenBridge.sol";
import {MockITokenBridge} from "./MovableCollateralRouter.t.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
// import {HypERC20MovableCollateral} from "contracts/token/HypERC20MovableCollateral.sol";

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";

import "forge-std/Test.sol";

contract HypERC20MovableCollateralRouterTest is Test {
    HypERC20Collateral internal router;
    MockITokenBridge internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);

    function setUp() public {
        token = new ERC20Test("Foo Token", "FT", 0, 18);
        router = new HypERC20Collateral(
            address(token),
            1e18,
            address(new MockMailbox(uint32(1)))
        );
        // Initialize the router -> we are the admin
        router.initialize(address(0), address(0), address(this));

        vtb = new MockITokenBridge(token);
    }

    function _configure(bytes32 _recipient) internal {
        // Grant permissions
        router.addRebalancer(address(this));

        // Enroll the remote router
        router.enrollRemoteRouter(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // Add the destination domain
        router.setRecipient(destinationDomain, _recipient);

        // Add the given bridge
        router.addBridge(destinationDomain, vtb);
    }

    function testMovingCollateral() public {
        // Configuration
        _configure(bytes32(uint256(uint160(alice))));

        // Setup - approvals happen automatically
        token.mintTo(address(router), 1e18);

        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
        // Assert
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(vtb)), 1e18);
    }

    function testFuzz_MovingCollateral(
        uint256 amount,
        bytes32 recipient
    ) public {
        vm.assume(recipient != bytes32(0));

        // Configuration

        _configure(recipient);

        // Setup - approvals happen automatically
        token.mintTo(address(router), amount);

        // Execute
        router.rebalance(destinationDomain, amount, vtb);
        // Assert
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(vtb)), amount);
    }
}
