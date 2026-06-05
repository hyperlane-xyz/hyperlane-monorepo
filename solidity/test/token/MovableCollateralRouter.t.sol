// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MovableCollateralRouter} from "contracts/token/libs/MovableCollateralRouter.sol";
import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {Router} from "contracts/client/Router.sol";
import {TokenRouter} from "contracts/token/libs/TokenRouter.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {Quotes} from "contracts/token/libs/Quotes.sol";

import "forge-std/Test.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract MockMovableCollateralRouter is MovableCollateralRouter {
    uint256 public chargedToRebalancer;
    address _token;

    constructor(address _mailbox, address __token) TokenRouter(1, 1, _mailbox) {
        _token = __token;
    }

    function token() public view override returns (address) {
        return _token;
    }

    function _transferFromSender(uint256 _amount) internal override {
        chargedToRebalancer = _amount;
    }

    function _transferTo(address _to, uint256 _amount) internal override {}
}

contract MockITokenBridge is ITokenBridge {
    using TypeCasts for bytes32;

    ERC20Test token;
    uint256 collateralFee;
    uint256 nativeFee;

    constructor(ERC20Test _token) {
        token = _token;
    }

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32 transferId) {
        require(msg.value >= nativeFee);
        token.transferFrom(
            msg.sender,
            address(this),
            amountOut + collateralFee
        );
        return recipient;
    }

    function setCollateralFee(uint256 _fee) public {
        collateralFee = _fee;
    }

    function setNativeFee(uint256 _fee) public {
        nativeFee = _fee;
    }

    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) public view override returns (Quote[] memory) {
        Quote[] memory quotes = new Quote[](2);
        quotes[0] = Quote(address(0), nativeFee);
        quotes[1] = Quote(address(token), amountOut + collateralFee);
        return quotes;
    }
}

contract MovableCollateralRouterTest is Test {
    using TypeCasts for address;
    using Quotes for Quote[];

    MockMovableCollateralRouter internal router;
    MockITokenBridge internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);
    MockMailbox mailbox;
    address remote;

    function setUp() public {
        mailbox = new MockMailbox(1);
        token = new ERC20Test("Foo Token", "FT", 0, 18);
        router = new MockMovableCollateralRouter(
            address(mailbox),
            address(token)
        );
        vtb = new MockITokenBridge(token);

        remote = vm.addr(10);
        router.enrollRemoteRouter(destinationDomain, remote.addressToBytes32());
    }

    function test_rebalance(
        uint256 collateralBalance,
        uint256 collateralAmount,
        uint256 collateralFee,
        uint256 nativeFee
    ) public {
        vm.assume(collateralBalance < type(uint256).max / 3);
        collateralAmount = bound(collateralAmount, 0, collateralBalance);
        collateralFee = bound(collateralFee, 0, collateralAmount);

        router.addRebalancer(address(this));

        // Setup
        token.mintTo(address(router), collateralBalance + collateralFee);
        router.addBridge(destinationDomain, vtb);

        vtb.setCollateralFee(collateralFee);
        vtb.setNativeFee(nativeFee);
        vm.deal(address(this), nativeFee);

        // Execute
        vm.expectCall(
            address(vtb),
            nativeFee,
            abi.encodeWithSelector(
                bytes4(keccak256("transferRemote(uint32,bytes32,uint256)")),
                destinationDomain,
                remote.addressToBytes32(),
                collateralAmount
            )
        );
        router.rebalance{value: nativeFee}(
            destinationDomain,
            collateralAmount,
            vtb
        );

        assertEq(router.chargedToRebalancer(), collateralFee);
        assertEq(token.allowance(address(router), address(vtb)), 0);
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
        router.addRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // We didn't add the bridge
        vm.expectRevert("MCR: Not allowed bridge");
        // Execute
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function testApproveTokenForBridge_clearsLegacyApproval() public {
        vm.prank(address(router));
        token.approve(address(vtb), type(uint256).max);
        assertEq(
            token.allowance(address(router), address(vtb)),
            type(uint256).max
        );

        router.approveTokenForBridge(token, vtb);

        assertEq(token.allowance(address(router), address(vtb)), 0);
    }

    function testAddBridge() public {
        router.addBridge(destinationDomain, vtb);
        assertEq(router.allowedBridges(destinationDomain).length, 1);
        assertEq(router.allowedBridges(destinationDomain)[0], address(vtb));
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

        // Add rebalancer
        router.addRebalancer(address(this));

        // Using the bridge should not work, because we clear the inner mapping of values to indexes
        vm.expectRevert("MCR: Not allowed bridge");
        router.rebalance(destinationDomain, 1e18, vtb);
    }

    function test_unenrollRemoteRouter() public {
        router.addBridge(destinationDomain, vtb);
        router.addRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.unenrollRemoteRouter(destinationDomain);
        assertEq(router.allowedBridges(destinationDomain).length, 0);
        assertEq(router.allowedRecipients(destinationDomain).length, 0);
    }

    function test_addBridge_NotEnrolled() public {
        router.unenrollRemoteRouter(destinationDomain);
        vm.expectRevert(); // router not enrolled
        router.addBridge(destinationDomain, vtb);
    }

    function testApproveTokenForBridge_NotOwner() public {
        address notAdmin = address(1);
        vm.expectRevert("Ownable: caller is not the owner");

        // Execute
        vm.prank(notAdmin);
        router.approveTokenForBridge(token, vtb);
    }

    function testDefaultRecipient() public {
        router.addRebalancer(address(this));

        // Add the given bridge
        router.addBridge(destinationDomain, vtb);

        token.mintTo(address(router), 1e18);

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
        assertTrue(router.isAllowedRebalancer(rebalancer));
    }

    function testRemoveRebalancer() public {
        router.addRebalancer(address(1));
        router.removeRebalancer(address(1));
        assertEq(router.allowedRebalancers().length, 0);
        assertFalse(router.isAllowedRebalancer(address(1)));
    }

    function testAddRecipient() public {
        bytes32 recipient = bytes32(uint256(uint160(alice)));
        router.addRecipient(destinationDomain, recipient);
        bytes32[] memory recipients = router.allowedRecipients(
            destinationDomain
        );
        assertEq(recipients.length, 1);
        assertEq(recipients[0], recipient);
        assertTrue(router.isAllowedRecipient(destinationDomain, recipient));
    }

    function testAddRecipient_multiple() public {
        bytes32 first = bytes32(uint256(uint160(alice)));
        bytes32 second = bytes32(uint256(uint160(address(2))));
        router.addRecipient(destinationDomain, first);
        router.addRecipient(destinationDomain, second);
        assertEq(router.allowedRecipients(destinationDomain).length, 2);
        assertTrue(router.isAllowedRecipient(destinationDomain, first));
        assertTrue(router.isAllowedRecipient(destinationDomain, second));
    }

    function testEnrolledRouterAlwaysAllowed() public view {
        assertTrue(
            router.isAllowedRecipient(
                destinationDomain,
                router.routers(destinationDomain)
            )
        );
    }

    function testAddRecipient_NotEnrolled() public {
        router.unenrollRemoteRouter(destinationDomain);
        vm.expectRevert(); // router not enrolled
        router.addRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
    }

    function testRemoveRecipient() public {
        bytes32 recipient = bytes32(uint256(uint160(alice)));
        router.addRecipient(destinationDomain, recipient);
        router.removeRecipient(destinationDomain, recipient);
        assertEq(router.allowedRecipients(destinationDomain).length, 0);
        assertFalse(router.isAllowedRecipient(destinationDomain, recipient));
    }

    function test_rebalance_toAllowedRecipient() public {
        router.addRebalancer(address(this));
        router.addBridge(destinationDomain, vtb);
        token.mintTo(address(router), 1e18);

        bytes32 recipient = bytes32(uint256(uint160(alice)));
        router.addRecipient(destinationDomain, recipient);

        vm.expectEmit(true, true, true, true);
        emit MovableCollateralRouter.CollateralMoved(
            destinationDomain,
            recipient,
            1e18,
            address(this)
        );
        router.rebalance(destinationDomain, recipient, 1e18, vtb);
    }

    function test_rebalance_toDisallowedRecipient_reverts() public {
        router.addRebalancer(address(this));
        router.addBridge(destinationDomain, vtb);
        token.mintTo(address(router), 1e18);

        vm.expectRevert("MCR: Recipient not allowed");
        router.rebalance(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1e18,
            vtb
        );
    }

    function test_rebalance_zeroRecipientDefaultsToEnrolled() public {
        router.addRebalancer(address(this));
        router.addBridge(destinationDomain, vtb);
        token.mintTo(address(router), 1e18);

        bytes32 defaultRecipient = router.routers(destinationDomain);
        vm.expectEmit(true, true, true, true);
        emit MovableCollateralRouter.CollateralMoved(
            destinationDomain,
            defaultRecipient,
            1e18,
            address(this)
        );
        router.rebalance(destinationDomain, bytes32(0), 1e18, vtb);
    }

    function testAllRebalancers() public {
        router.removeRebalancer(address(this));

        router.addRebalancer(address(1));
        address[] memory rebalancers = router.allowedRebalancers();
        assertEq(rebalancers.length, 1);
        assertEq(rebalancers[0], address(1));
    }
}
