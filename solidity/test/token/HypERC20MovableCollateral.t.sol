// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ValueTransferBridge} from "contracts/token/libs/ValueTransferBridge.sol";
import {MockValueTransferBridge} from "./MovableCollateralRouter.t.sol";
import {HypERC20MovableCollateral} from "contracts/token/HypERC20MovableCollateral.sol";

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";

import "forge-std/Test.sol";

contract HypERC20MovableCollateralRouterTest is Test {
    HypERC20MovableCollateral internal router;
    MockValueTransferBridge internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);

    function setUp() public {
        token = new ERC20Test("Foo Token", "FT", 1_000_000e18, 18);
        router = new HypERC20MovableCollateral(
            address(token),
            1e18,
            address(new MockMailbox(uint32(1)))
        );

        vtb = new MockValueTransferBridge(token);
    }

    function testMovingCollateral() public {
        // Configuration
        // Grant permissions
        router.grantRole(router.REBALANCER_ROLE(), address(this));

        // Add the destination domain
        router.addRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // Add the given bridge
        router.addBridge(vtb, destinationDomain);

        // Setup - approvals happen automatically
        token.mintTo(address(router), 1e18);

        // Execute
        router.moveCollateral(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1e18,
            vtb
        );
        // Assert
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(vtb)), 1e18);
    }
}
