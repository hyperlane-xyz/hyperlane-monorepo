// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ValueTransferBridge} from "contracts/token/libs/ValueTransferBridge.sol";
import {HypNativeMovable} from "contracts/token/HypNativeMovable.sol";

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";

import "forge-std/Test.sol";

contract MockValueTransferBridgeEth is ValueTransferBridge {
    constructor() {}

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32 transferId) {
        return keccak256("fake message");
    }
}

contract HypNativeMovableTest is Test {
    HypNativeMovable internal router;
    MockValueTransferBridgeEth internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);

    function setUp() public {
        token = new ERC20Test("Foo Token", "FT", 1_000_000e18, 18);
        router = new HypNativeMovable(
            1e18,
            address(new MockMailbox(uint32(1)))
        );

        vtb = new MockValueTransferBridgeEth();
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

        // Setup - send ether to router
        deal(address(router), 1 ether);

        // Execute
        router.moveCollateral(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1 ether,
            vtb
        );
        // Assert
        assertEq(address(router).balance, 0);
        assertEq(address(vtb).balance, 1 ether);
    }
}
