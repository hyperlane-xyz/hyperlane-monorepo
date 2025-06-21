// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MovableCollateralRouter} from "contracts/token/libs/MovableCollateralRouter.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {Router} from "contracts/client/Router.sol";
import {FungibleTokenRouter} from "contracts/token/libs/FungibleTokenRouter.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract MockMovableCollateralRouter is MovableCollateralRouter {
    constructor(address _mailbox) FungibleTokenRouter(1, _mailbox) {}

    function _token() internal view override returns (address) {
        return address(0);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {}

    function _transferTo(
        address _to,
        uint256 _amount,
        bytes calldata _metadata
    ) internal override {}

    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {}
}

contract MockITokenBridge is ITokenBridge {
    ERC20Test token;
    bytes32 public myRecipient;

    constructor(ERC20Test _token) {
        token = _token;
    }

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32 transferId) {
        token.transferFrom(msg.sender, address(this), amountOut);
        myRecipient = recipient;
        return recipient;
    }

    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) public view override returns (Quote[] memory) {
        return new Quote[](0);
    }
}

contract MovableCollateralRouterTest is Test {
    using TypeCasts for address;

    MovableCollateralRouter internal router;
    MockITokenBridge internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);
    MockMailbox mailbox;
    address remote;

    function setUp() public {
        mailbox = new MockMailbox(1);
        router = new MockMovableCollateralRouter(address(mailbox));
        token = new ERC20Test("Foo Token", "FT", 1_000_000e18, 18);
        vtb = new MockITokenBridge(token);

        remote = vm.addr(10);

        router.enrollRemoteRouter(destinationDomain, remote.addressToBytes32());
    }

    function testMovingCollateral() public {
        router.addRebalancer(address(this));

        // Configuration
        // Add the destination domain
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // Add the given bridge
        router.addBridge(destinationDomain, vtb);

        // Setup
        token.mintTo(address(router), 1e18);
        vm.prank(address(router));
        token.approve(address(vtb), 1e18);

        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
        // Assert
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(vtb)), 1e18);
    }

    function testBadRebalancer() public {
        vm.expectRevert("MCR: Only Rebalancer");
        vm.prank(address(1));
        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function testBadBridge() public {
        // Configuration
        router.addRebalancer(address(this));

        // Add the destination domain
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // We didn't add the bridge
        vm.expectRevert("MCR: Not allowed bridge");
        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function testAddBridge() public {
        router.addBridge(destinationDomain, vtb);
        assertEq(router.allowedBridges(destinationDomain).length, 1);
        assertEq(router.allowedBridges(destinationDomain)[0], address(vtb));
        // TODO: check infinite approval
    }

    function testRemoveBridge() public {
        router.addBridge(destinationDomain, vtb);
        router.removeBridge(destinationDomain, vtb);
        assertEq(router.allowedBridges(destinationDomain).length, 0);
    }

    function test_bridgeUnusable_after_deletion() public {
        // Bridge is added and then supposedly removed during router unenrollment
        test_unenrollRemoteRouter();

        // We re-enroll the router but don't re-add the bridge
        router.enrollRemoteRouter(destinationDomain, remote.addressToBytes32());

        // Approvals
        token.mintTo(address(router), 1e18);
        vm.prank(address(router));
        token.approve(address(vtb), 1e18);
        // Add rebalancer
        router.addRebalancer(address(this));

        // Using the bridge should not work, because we clear the inner mapping of values to indexes
        vm.expectRevert("MCR: Not allowed bridge");
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function test_unenrollRemoteRouter() public {
        router.addBridge(destinationDomain, vtb);
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.unenrollRemoteRouter(destinationDomain);
        assertEq(router.allowedBridges(destinationDomain).length, 0);
        assertEq(router.allowedRecipient(destinationDomain), bytes32(0));
    }

    function test_addBridge_NotEnrolled() public {
        router.unenrollRemoteRouter(destinationDomain);
        vm.expectRevert(); // router not enrolled
        router.addBridge(destinationDomain, vtb);
    }

    function testDefaultRecipient() public {
        router.addRebalancer(address(this));

        // Add the given bridge
        router.addBridge(destinationDomain, vtb);

        // Approvals
        token.mintTo(address(router), 1e18);
        vm.prank(address(router));
        token.approve(address(vtb), 1e18);

        bytes32 defaultRecipient = router.routers(destinationDomain);

        // Execute
        vm.expectEmit(true, true, true, true);
        emit MovableCollateralRouter.CollateralMoved(
            destinationDomain,
            defaultRecipient,
            1e18,
            address(this)
        );
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function testAddRebalancer() public {
        address rebalancer = address(1);
        router.addRebalancer(rebalancer);
        assertEq(router.allowedRebalancers()[0], rebalancer);
    }

    function testRemoveRebalancer() public {
        router.addRebalancer(address(1));
        router.removeRebalancer(address(1));
        assertEq(router.allowedRebalancers().length, 0);
    }

    function testSetRecipient() public {
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        bytes32 recipient = router.allowedRecipient(destinationDomain);
        assertEq(recipient, bytes32(uint256(uint160(alice))));
    }

    function testSetRecipient_NotEnrolled() public {
        router.unenrollRemoteRouter(destinationDomain);
        vm.expectRevert(); // router not enrolled
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
    }

    function testRemoveRecipient() public {
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.removeRecipient(destinationDomain);
        assertEq(router.allowedRecipient(destinationDomain), bytes32(0));
    }

    function testAllRebalancers() public {
        router.removeRebalancer(address(this));

        router.addRebalancer(address(1));
        address[] memory rebalancers = router.allowedRebalancers();
        assertEq(rebalancers.length, 1);
        assertEq(rebalancers[0], address(1));
    }
}
