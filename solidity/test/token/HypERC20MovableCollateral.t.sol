// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridge} from "contracts/interfaces/ITokenBridge.sol";
import {MockITokenBridge} from "./MovableCollateralRouter.t.sol";
import {HypERC20Collateral} from "contracts/token/HypERC20Collateral.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";

import "forge-std/Test.sol";

contract HypERC20MovableCollateralRouterTest is Test {
    HypERC20Collateral internal router;
    MockITokenBridge internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    uint32 internal constant otherDestinationDomain = 3;
    address internal constant alice = address(1);

    function setUp() public {
        token = new ERC20Test("Foo Token", "FT", 0, 18);
        router = new HypERC20Collateral(
            address(token),
            1e18,
            1,
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

    function test_rebalance() public {
        // Configuration
        _configure(bytes32(uint256(uint160(alice))));

        uint256 amount = 1e18;

        // Setup - approvals happen automatically
        token.mintTo(address(router), amount);

        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
        // Assert
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(vtb)), 1e18);
    }

    function testFuzz_rebalance(uint256 amount, bytes32 recipient) public {
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

    function test_addBridge_call_with_same_bridge_address_multiple_times()
        public
    {
        // Configuration
        router.addRebalancer(address(this));
        router.enrollRemoteRouter(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.enrollRemoteRouter(
            otherDestinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // Should call approve to give max allowance to the bridge
        vm.expectCall(
            address(token),
            abi.encodeCall(token.approve, (address(vtb), type(uint256).max))
        );
        router.addBridge(destinationDomain, vtb);

        // Verify allowance is set to max
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max,
            "Allowance should be max after first addBridge call"
        );

        // Second call to addBridge with the same address but different domain should work
        router.addBridge(otherDestinationDomain, vtb);

        // Allowance should not have changed
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max,
            "Allowance should still be max after second addBridge call"
        );
    }

    function test_removeBridge_should_revoke_allowance_if_bridge_is_not_set_for_other_domains()
        public
    {
        // Configuration
        router.addRebalancer(address(this));
        router.enrollRemoteRouter(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.enrollRemoteRouter(
            otherDestinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        router.addBridge(destinationDomain, vtb);

        // Verify allowance is set to max
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max,
            "Allowance should be max after first addBridge call"
        );

        // Allowance should be set to 0
        vm.expectCall(
            address(token),
            abi.encodeCall(token.approve, (address(vtb), 0))
        );
        router.removeBridge(destinationDomain, vtb);

        // Allowance should be reset
        assertEq(
            token.allowance(address(router), address(vtb)),
            uint256(0),
            "Allowance should be 0 after removing the bridge"
        );
    }

    function test_removeBridge_should_not_revoke_allowance_if_bridge_is_set_for_other_domains()
        public
    {
        // Configuration
        router.addRebalancer(address(this));
        router.enrollRemoteRouter(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.enrollRemoteRouter(
            otherDestinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        router.addBridge(destinationDomain, vtb);
        router.addBridge(otherDestinationDomain, vtb);

        // Verify allowance is set to max
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max,
            "Allowance should be max after addBridge call"
        );

        // Should not call approve to revoke
        vm.expectCall(
            address(token),
            abi.encodeWithSelector(token.approve.selector),
            0
        );
        router.removeBridge(destinationDomain, vtb);

        // Allowance should still be set to max
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max,
            "Allowance should still be set to max after removing the bridge only for one domain"
        );
    }
}
