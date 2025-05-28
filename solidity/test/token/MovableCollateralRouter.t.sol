// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MovableCollateralRouter, ValueTransferBridge} from "contracts/token/libs/MovableCollateralRouter.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {Router} from "contracts/client/Router.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";

import "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract MockMovableCollateralRouter is MovableCollateralRouter {
    constructor(address _mailbox) Router(_mailbox) {}
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {}
}

contract MockValueTransferBridge is ValueTransferBridge {
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
}

contract MovableCollateralRouterTest is Test {
    using TypeCasts for address;

    MovableCollateralRouter internal router;
    MockValueTransferBridge internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);
    MockMailbox mailbox;

    function setUp() public {
        mailbox = new MockMailbox(1);
        router = new MockMovableCollateralRouter(address(mailbox));
        token = new ERC20Test("Foo Token", "FT", 1_000_000e18, 18);
        vtb = new MockValueTransferBridge(token);
        router.addRebalancer(address(this));
    }

    function testMovingCollateral() public {
        // Configuration
        // Add the destination domain
        router.addRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // Add the given bridge
        router.addBridge(vtb, destinationDomain);

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

        // Add the destination domain
        router.addRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // We didn't add the bridge
        vm.expectRevert(
            abi.encodeWithSelector(
                MovableCollateralRouter.BadBridge.selector,
                address(this),
                vtb
            )
        );
        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function testApproveTokenForBridge() public {
        // Configuration
        // Execute
        router.approveTokenForBridge(token, vtb);

        // Assert
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max
        );
    }

    function testApproveTokenForBridge_NotOwner() public {
        address notAdmin = address(1);
        vm.expectRevert("Ownable: caller is not the owner");

        // Execute
        vm.prank(notAdmin);
        router.approveTokenForBridge(token, vtb);
    }

    function testWeUseTheRouterMapping() public {
        // TODO: we should inspect the collateral moved event to make sure we sent message to Alice
        // Add remote router to serve as default recipient
        router.enrollRemoteRouter(destinationDomain, alice.addressToBytes32());

        //
        // Add the given bridge
        router.addBridge(vtb, destinationDomain);

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

    function testDefaultRecipient() public {
        // Skipping adding the recipient to the destination mappings

        // Add the given bridge
        router.addBridge(vtb, destinationDomain);

        // Router setup
        bytes32 remoteRouter = address(10).addressToBytes32();
        router.enrollRemoteRouter(destinationDomain, remoteRouter);

        // Approvals
        token.mintTo(address(router), 1e18);
        vm.prank(address(router));
        token.approve(address(vtb), 1e18);

        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);

        // Assert
        assertEq(vtb.myRecipient(), remoteRouter);
    }
}
