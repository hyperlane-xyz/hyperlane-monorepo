// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {MockPredicateRegistry} from "../../contracts/mock/MockPredicateRegistry.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {CrossCollateralRouter} from "../../contracts/token/CrossCollateralRouter.sol";
import {PredicateCrossCollateralRouterWrapper} from "../../contracts/token/PredicateCrossCollateralRouterWrapper.sol";
import {Statement, Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";

/**
 * @title PredicateCrossCollateralRouterWrapperTest
 * @notice Tests PredicateCrossCollateralRouterWrapper with a CrossCollateralRouter
 */
contract PredicateCrossCollateralRouterWrapperTest is Test {
    using TypeCasts for address;

    // Constants
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 100e18;
    string internal constant POLICY_ID = "test-policy-123";

    // Addresses
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant ATTESTER = address(0x3);

    // Contracts
    ERC20Test internal primaryToken;
    ERC20Test internal destToken; // held by routerC for same-domain swap
    CrossCollateralRouter internal routerA; // ORIGIN, wrapped by predicateWrapper
    CrossCollateralRouter internal routerB; // DESTINATION, enrolled with A
    CrossCollateralRouter internal routerC; // ORIGIN, for same-domain transferRemoteTo
    PredicateCrossCollateralRouterWrapper internal predicateWrapper;
    MockPredicateRegistry internal registry;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;

    // Events
    event PredicateRegistryUpdated(
        address indexed oldRegistry,
        address indexed newRegistry
    );
    event PredicatePolicyIDUpdated(string oldPolicyID, string newPolicyID);
    event TransferAuthorized(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 targetRouter,
        string uuid
    );

    function setUp() public virtual {
        // Setup mailboxes
        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        // Setup hooks
        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        // Deploy tokens
        primaryToken = new ERC20Test(
            "USD Coin",
            "USDC",
            TOTAL_SUPPLY,
            DECIMALS
        );
        destToken = new ERC20Test("Tether USD", "USDT", TOTAL_SUPPLY, DECIMALS);

        // Deploy routerA (ORIGIN, primaryToken)
        routerA = new CrossCollateralRouter(
            address(primaryToken),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        routerA.initialize(address(noopHook), address(0), address(this));

        // Deploy routerB (DESTINATION, primaryToken — same-stablecoin cross-chain)
        routerB = new CrossCollateralRouter(
            address(primaryToken),
            SCALE,
            SCALE,
            address(remoteMailbox)
        );
        routerB.initialize(address(noopHook), address(0), address(this));

        // Deploy routerC (ORIGIN, destToken — same-domain cross-token swap)
        routerC = new CrossCollateralRouter(
            address(destToken),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        routerC.initialize(address(noopHook), address(0), address(this));

        // Enroll routers for cross-chain (A <-> B)
        routerA.enrollRemoteRouter(
            DESTINATION,
            address(routerB).addressToBytes32()
        );
        routerB.enrollRemoteRouter(ORIGIN, address(routerA).addressToBytes32());

        // Enroll routerC in routerA for same-domain transfers (A → C)
        uint32[] memory domains = new uint32[](1);
        bytes32[] memory routers = new bytes32[](1);
        domains[0] = ORIGIN;
        routers[0] = address(routerC).addressToBytes32();
        routerA.enrollCrossCollateralRouters(domains, routers);
        // routerC must accept calls from routerA
        domains[0] = ORIGIN;
        routers[0] = address(routerA).addressToBytes32();
        routerC.enrollCrossCollateralRouters(domains, routers);

        // Seed routers with collateral
        primaryToken.transfer(address(routerA), 400_000e18);
        primaryToken.transfer(address(routerB), 400_000e18);
        destToken.transfer(address(routerC), 500_000e18);

        // Deploy mock predicate registry
        registry = new MockPredicateRegistry();
        registry.registerAttester(ATTESTER);

        // Deploy predicate wrapper
        predicateWrapper = new PredicateCrossCollateralRouterWrapper(
            address(routerA),
            address(registry),
            POLICY_ID
        );

        // Set predicate wrapper as hook on routerA
        routerA.setHook(address(predicateWrapper));

        // Fund ALICE
        primaryToken.transfer(ALICE, 100_000e18);
        vm.deal(ALICE, 10 ether);
    }

    // ============ Helper Functions ============

    function _createAttestation(
        string memory uuid,
        uint256 expiration
    ) internal pure returns (Attestation memory) {
        return
            Attestation({
                uuid: uuid,
                expiration: expiration,
                attester: ATTESTER,
                signature: hex""
            });
    }

    function _approveAndTransferRemote(
        address sender,
        uint256 amount,
        Attestation memory attestation
    ) internal returns (bytes32) {
        vm.startPrank(sender);
        primaryToken.approve(address(predicateWrapper), amount);
        bytes32 messageId = predicateWrapper.transferRemoteWithAttestation{
            value: 0
        }(attestation, DESTINATION, BOB.addressToBytes32(), amount);
        vm.stopPrank();
        return messageId;
    }

    function _approveAndTransferRemoteTo(
        address sender,
        uint256 amount,
        uint32 destination,
        bytes32 targetRouter,
        Attestation memory attestation
    ) internal returns (bytes32) {
        vm.startPrank(sender);
        primaryToken.approve(address(predicateWrapper), amount);
        bytes32 messageId = predicateWrapper.transferRemoteToWithAttestation{
            value: 0
        }(
            attestation,
            destination,
            BOB.addressToBytes32(),
            amount,
            targetRouter
        );
        vm.stopPrank();
        return messageId;
    }

    // ============ Constructor Tests ============

    function test_constructor_setsCrossCollateralRouter() public view {
        assertEq(
            address(predicateWrapper.crossCollateralRouter()),
            address(routerA)
        );
    }

    function test_constructor_setsToken() public view {
        assertEq(address(predicateWrapper.token()), address(primaryToken));
    }

    function test_constructor_setsLocalDomain() public view {
        assertEq(predicateWrapper.localDomain(), ORIGIN);
    }

    function test_constructor_setsRegistry() public view {
        assertEq(predicateWrapper.getRegistry(), address(registry));
    }

    function test_constructor_setsPolicyID() public view {
        assertEq(predicateWrapper.getPolicyID(), POLICY_ID);
    }

    function test_constructor_registersPolicyWithRegistry() public view {
        assertEq(registry.getPolicyID(address(predicateWrapper)), POLICY_ID);
    }

    function test_constructor_setsOwner() public view {
        assertEq(predicateWrapper.owner(), address(this));
    }

    function test_constructor_revert_ifZeroRouter() public {
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InvalidRouter
                .selector
        );
        new PredicateCrossCollateralRouterWrapper(
            address(0),
            address(registry),
            POLICY_ID
        );
    }

    function test_constructor_revert_ifZeroRegistry() public {
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InvalidRegistry
                .selector
        );
        new PredicateCrossCollateralRouterWrapper(
            address(routerA),
            address(0),
            POLICY_ID
        );
    }

    function test_constructor_revert_ifEmptyPolicy() public {
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InvalidPolicy
                .selector
        );
        new PredicateCrossCollateralRouterWrapper(
            address(routerA),
            address(registry),
            ""
        );
    }

    // ============ transferRemoteWithAttestation Tests (cross-domain) ============

    function test_transferRemoteWithAttestation_success() public {
        Attestation memory attestation = _createAttestation(
            "uuid-1",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 routerABalanceBefore = primaryToken.balanceOf(address(routerA));

        bytes32 messageId = _approveAndTransferRemote(
            ALICE,
            TRANSFER_AMT,
            attestation
        );

        assertTrue(messageId != bytes32(0));
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
        assertEq(
            primaryToken.balanceOf(address(routerA)),
            routerABalanceBefore + TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_emitsTransferAuthorized()
        public
    {
        Attestation memory attestation = _createAttestation(
            "uuid-events",
            block.timestamp + 1 hours
        );

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.expectEmit(true, true, true, true);
        emit TransferAuthorized(
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            bytes32(0), // No specific router for transferRemote
            "uuid-events"
        );

        predicateWrapper.transferRemoteWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();
    }

    function test_transferRemoteWithAttestation_processesOnRemote() public {
        Attestation memory attestation = _createAttestation(
            "uuid-remote",
            block.timestamp + 1 hours
        );

        _approveAndTransferRemote(ALICE, TRANSFER_AMT, attestation);

        uint256 bobBefore = primaryToken.balanceOf(BOB);
        remoteMailbox.processNextInboundMessage();

        assertEq(primaryToken.balanceOf(BOB), bobBefore + TRANSFER_AMT);
    }

    function test_transferRemoteWithAttestation_clearsPendingFlag() public {
        Attestation memory attestation = _createAttestation(
            "uuid-flag",
            block.timestamp + 1 hours
        );

        assertFalse(predicateWrapper.pendingAttestation());

        _approveAndTransferRemote(ALICE, TRANSFER_AMT, attestation);

        assertFalse(predicateWrapper.pendingAttestation());
    }

    function test_transferRemoteWithAttestation_revert_ifAttestationInvalid()
        public
    {
        Attestation memory attestation = _createAttestation(
            "uuid-invalid",
            block.timestamp + 1 hours
        );
        registry.setShouldValidate(false);

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__AttestationInvalid
                .selector
        );
        predicateWrapper.transferRemoteWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_revert_ifRegistryReverts()
        public
    {
        Attestation memory attestation = _createAttestation(
            "uuid-revert",
            block.timestamp + 1 hours
        );
        registry.setShouldRevert(true, "Attestation expired");

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert("Attestation expired");
        predicateWrapper.transferRemoteWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_revert_ifReplayAttack() public {
        Attestation memory attestation = _createAttestation(
            "replay-uuid",
            block.timestamp + 1 hours
        );

        _approveAndTransferRemote(ALICE, TRANSFER_AMT, attestation);

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert("MockPredicateRegistry: UUID already used");
        predicateWrapper.transferRemoteWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_revert_ifInsufficientAllowance()
        public
    {
        Attestation memory attestation = _createAttestation(
            "uuid-noallowance",
            block.timestamp + 1 hours
        );

        // No approval
        vm.prank(ALICE);
        vm.expectRevert();
        predicateWrapper.transferRemoteWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_revert_ifInsufficientBalance()
        public
    {
        Attestation memory attestation = _createAttestation(
            "uuid-nobalance",
            block.timestamp + 1 hours
        );

        uint256 tooMuch = primaryToken.balanceOf(ALICE) + 1;

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), tooMuch);

        vm.prank(ALICE);
        vm.expectRevert();
        predicateWrapper.transferRemoteWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            tooMuch
        );
    }

    function test_transferRemoteWithAttestation_revert_ifInsufficientValue()
        public
    {
        // Set a non-zero required fee so totalNativeRequired > 0
        TestPostDispatchHook feeHook = new TestPostDispatchHook();
        feeHook.setFee(1 ether);
        localMailbox.setRequiredHook(address(feeHook));

        Attestation memory attestation = _createAttestation(
            "uuid-insufficientvalue",
            block.timestamp + 1 hours
        );

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InsufficientValue
                .selector
        );
        predicateWrapper.transferRemoteWithAttestation{value: 0.5 ether}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_refundsExcessETH() public {
        // Set a non-zero required fee so we can test refund
        TestPostDispatchHook feeHook = new TestPostDispatchHook();
        feeHook.setFee(0.1 ether);
        localMailbox.setRequiredHook(address(feeHook));

        Attestation memory attestation = _createAttestation(
            "uuid-excesseth",
            block.timestamp + 1 hours
        );

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 aliceEthBefore = ALICE.balance;

        vm.prank(ALICE);
        predicateWrapper.transferRemoteWithAttestation{value: 1 ether}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Alice pays only the required 0.1 ether; excess 0.9 ether is refunded
        assertEq(ALICE.balance, aliceEthBefore - 0.1 ether);
    }

    function test_transferRemoteWithAttestation_refundFailed_revertsIfCallerRejectsETH()
        public
    {
        TestPostDispatchHook feeHook = new TestPostDispatchHook();
        feeHook.setFee(0.1 ether);
        localMailbox.setRequiredHook(address(feeHook));

        CCRRefundRejecter rejecter = new CCRRefundRejecter(predicateWrapper);
        primaryToken.transfer(address(rejecter), TRANSFER_AMT);
        vm.deal(address(rejecter), 10 ether);

        Attestation memory attestation = _createAttestation(
            "uuid-refundfail",
            block.timestamp + 1 hours
        );

        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__RefundFailed
                .selector
        );
        rejecter.doTransferRemote{value: 1 ether}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    // ============ Bypass Prevention Tests ============

    function test_bypassPrevention_directTransferRemoteReverts() public {
        vm.prank(ALICE);
        primaryToken.approve(address(routerA), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__UnauthorizedTransfer
                .selector
        );
        routerA.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_bypassPrevention_pendingFlagInitiallyFalse() public view {
        assertFalse(predicateWrapper.pendingAttestation());
    }

    // ============ transferRemoteToWithAttestation Tests (cross-domain) ============

    function test_transferRemoteToWithAttestation_crossDomain_success() public {
        bytes32 targetRouter = address(routerB).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-remoteto",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);

        bytes32 messageId = _approveAndTransferRemoteTo(
            ALICE,
            TRANSFER_AMT,
            DESTINATION,
            targetRouter,
            attestation
        );

        assertTrue(messageId != bytes32(0));
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
    }

    function test_transferRemoteToWithAttestation_crossDomain_emitsTransferAuthorized()
        public
    {
        bytes32 targetRouter = address(routerB).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-remoteto-events",
            block.timestamp + 1 hours
        );

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.expectEmit(true, true, true, true);
        emit TransferAuthorized(
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter,
            "uuid-remoteto-events"
        );

        predicateWrapper.transferRemoteToWithAttestation{value: 0}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );
        vm.stopPrank();
    }

    function test_transferRemoteToWithAttestation_crossDomain_processesOnRemote()
        public
    {
        bytes32 targetRouter = address(routerB).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-remoteto-remote",
            block.timestamp + 1 hours
        );

        _approveAndTransferRemoteTo(
            ALICE,
            TRANSFER_AMT,
            DESTINATION,
            targetRouter,
            attestation
        );

        uint256 bobBefore = primaryToken.balanceOf(BOB);
        remoteMailbox.processNextInboundMessage();

        assertEq(primaryToken.balanceOf(BOB), bobBefore + TRANSFER_AMT);
    }

    function test_transferRemoteToWithAttestation_crossDomain_clearsPendingFlag()
        public
    {
        bytes32 targetRouter = address(routerB).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-remoteto-flag",
            block.timestamp + 1 hours
        );

        assertFalse(predicateWrapper.pendingAttestation());

        _approveAndTransferRemoteTo(
            ALICE,
            TRANSFER_AMT,
            DESTINATION,
            targetRouter,
            attestation
        );

        assertFalse(predicateWrapper.pendingAttestation());
    }

    function test_transferRemoteToWithAttestation_crossDomain_revert_ifInsufficientValue()
        public
    {
        TestPostDispatchHook feeHook = new TestPostDispatchHook();
        feeHook.setFee(1 ether);
        localMailbox.setRequiredHook(address(feeHook));

        bytes32 targetRouter = address(routerB).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-remoteto-insufficientvalue",
            block.timestamp + 1 hours
        );

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InsufficientValue
                .selector
        );
        predicateWrapper.transferRemoteToWithAttestation{value: 0.5 ether}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );
    }

    function test_transferRemoteToWithAttestation_crossDomain_refundsExcessETH()
        public
    {
        TestPostDispatchHook feeHook = new TestPostDispatchHook();
        feeHook.setFee(0.1 ether);
        localMailbox.setRequiredHook(address(feeHook));

        bytes32 targetRouter = address(routerB).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-remoteto-excess",
            block.timestamp + 1 hours
        );

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 aliceEthBefore = ALICE.balance;

        vm.prank(ALICE);
        predicateWrapper.transferRemoteToWithAttestation{value: 1 ether}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );

        assertEq(ALICE.balance, aliceEthBefore - 0.1 ether);
    }

    // ============ transferRemoteToWithAttestation Tests (same-domain) ============

    function test_transferRemoteToWithAttestation_sameDomain_success() public {
        bytes32 targetRouter = address(routerC).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-samedomain",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 bobDestBefore = destToken.balanceOf(BOB);

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);
        bytes32 messageId = predicateWrapper.transferRemoteToWithAttestation{
            value: 0
        }(
            attestation,
            ORIGIN, // same-domain
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );
        vm.stopPrank();

        // Same-domain returns bytes32(0)
        assertEq(messageId, bytes32(0));
        // Alice's tokens are taken
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
        // BOB receives destToken from routerC synchronously (no mailbox needed)
        assertEq(destToken.balanceOf(BOB), bobDestBefore + TRANSFER_AMT);
    }

    function test_transferRemoteToWithAttestation_sameDomain_doesNotSetPendingFlag()
        public
    {
        bytes32 targetRouter = address(routerC).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-samedomain-flag",
            block.timestamp + 1 hours
        );

        assertFalse(predicateWrapper.pendingAttestation());

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);
        predicateWrapper.transferRemoteToWithAttestation{value: 0}(
            attestation,
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );
        vm.stopPrank();

        // Flag must remain false for same-domain (no postDispatch called)
        assertFalse(predicateWrapper.pendingAttestation());
    }

    function test_transferRemoteToWithAttestation_sameDomain_refundsExcessETH()
        public
    {
        bytes32 targetRouter = address(routerC).addressToBytes32();
        Attestation memory attestation = _createAttestation(
            "uuid-samedomain-excess",
            block.timestamp + 1 hours
        );

        uint256 aliceEthBefore = ALICE.balance;

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);
        // Same-domain requires 0 native; send excess — should be refunded
        predicateWrapper.transferRemoteToWithAttestation{value: 0.5 ether}(
            attestation,
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );
        vm.stopPrank();

        // CCR enforces msg.value == 0 for local transfers, but the wrapper
        // correctly forwards only totalNativeRequired (0) and refunds the rest
        assertEq(ALICE.balance, aliceEthBefore);
    }

    // ============ Admin Function Tests ============

    function test_setPolicyID_success() public {
        string memory newPolicy = "new-policy-456";

        vm.expectEmit(true, true, true, true);
        emit PredicatePolicyIDUpdated(POLICY_ID, newPolicy);

        predicateWrapper.setPolicyID(newPolicy);

        assertEq(predicateWrapper.getPolicyID(), newPolicy);
        assertEq(registry.getPolicyID(address(predicateWrapper)), newPolicy);
    }

    function test_setPolicyID_noop_ifSamePolicy() public {
        vm.recordLogs();
        predicateWrapper.setPolicyID(POLICY_ID);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        bool foundPolicyUpdatedEvent = false;
        for (uint i = 0; i < entries.length; i++) {
            if (
                entries[i].topics[0] ==
                keccak256("PredicatePolicyIDUpdated(string,string)")
            ) {
                foundPolicyUpdatedEvent = true;
            }
        }
        assertFalse(foundPolicyUpdatedEvent);
    }

    function test_setPolicyID_revert_ifNotOwner() public {
        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        predicateWrapper.setPolicyID("unauthorized-policy");
    }

    function test_setPolicyID_revert_ifEmptyPolicy() public {
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InvalidPolicy
                .selector
        );
        predicateWrapper.setPolicyID("");
    }

    function test_setRegistry_success() public {
        MockPredicateRegistry newRegistry = new MockPredicateRegistry();

        vm.expectEmit(true, true, true, true);
        emit PredicateRegistryUpdated(address(registry), address(newRegistry));

        predicateWrapper.setRegistry(address(newRegistry));

        assertEq(predicateWrapper.getRegistry(), address(newRegistry));
        assertEq(newRegistry.getPolicyID(address(predicateWrapper)), POLICY_ID);
    }

    function test_setRegistry_noop_ifSameRegistry() public {
        vm.recordLogs();
        predicateWrapper.setRegistry(address(registry));
        Vm.Log[] memory entries = vm.getRecordedLogs();

        bool foundRegistryUpdatedEvent = false;
        for (uint i = 0; i < entries.length; i++) {
            if (
                entries[i].topics[0] ==
                keccak256("PredicateRegistryUpdated(address,address)")
            ) {
                foundRegistryUpdatedEvent = true;
            }
        }
        assertFalse(foundRegistryUpdatedEvent);
    }

    function test_setRegistry_revert_ifNotOwner() public {
        MockPredicateRegistry newRegistry = new MockPredicateRegistry();

        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        predicateWrapper.setRegistry(address(newRegistry));
    }

    function test_setRegistry_revert_ifZeroAddress() public {
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__InvalidRegistry
                .selector
        );
        predicateWrapper.setRegistry(address(0));
    }

    // ============ Hook Interface Tests ============

    function test_hookType_returnsPredicateRouterWrapper() public view {
        assertEq(predicateWrapper.hookType(), 17); // PREDICATE_ROUTER_WRAPPER = 17
    }

    function test_quoteDispatch_returnsZero() public view {
        assertEq(predicateWrapper.quoteDispatch("", ""), 0);
    }

    function test_supportsMetadata_returnsTrue() public view {
        assertTrue(predicateWrapper.supportsMetadata(""));
    }

    // ============ ETH Handling Tests ============

    function test_receive_acceptsETH() public {
        vm.deal(address(this), 1 ether);
        (bool success, ) = address(predicateWrapper).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(predicateWrapper).balance, 1 ether);
    }

    function test_withdrawETH_success() public {
        vm.deal(address(predicateWrapper), 1 ether);

        uint256 ownerBefore = address(this).balance;
        predicateWrapper.withdrawETH();

        assertEq(address(predicateWrapper).balance, 0);
        assertEq(address(this).balance, ownerBefore + 1 ether);
    }

    function test_withdrawETH_revert_ifNotOwner() public {
        vm.deal(address(predicateWrapper), 1 ether);

        vm.prank(ALICE);
        vm.expectRevert("Ownable: caller is not the owner");
        predicateWrapper.withdrawETH();
    }

    // ============ Fuzz Tests ============

    function testFuzz_transferRemoteWithAttestation_variableAmounts(
        uint256 amount
    ) public {
        amount = bound(amount, 1, primaryToken.balanceOf(ALICE));

        Attestation memory attestation = _createAttestation(
            string(abi.encodePacked("fuzz-uuid-", vm.toString(amount))),
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);

        _approveAndTransferRemote(ALICE, amount, attestation);

        assertEq(primaryToken.balanceOf(ALICE), aliceBalanceBefore - amount);
    }

    function testFuzz_transferRemoteToWithAttestation_sameDomain_variableAmounts(
        uint256 amount
    ) public {
        amount = bound(amount, 1, primaryToken.balanceOf(ALICE));

        Attestation memory attestation = _createAttestation(
            string(
                abi.encodePacked("fuzz-samedomain-uuid-", vm.toString(amount))
            ),
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 bobDestBefore = destToken.balanceOf(BOB);

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), amount);
        predicateWrapper.transferRemoteToWithAttestation{value: 0}(
            attestation,
            ORIGIN,
            BOB.addressToBytes32(),
            amount,
            address(routerC).addressToBytes32()
        );
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), aliceBalanceBefore - amount);
        assertEq(destToken.balanceOf(BOB), bobDestBefore + amount);
    }

    // Required to receive ETH from withdrawETH
    receive() external payable {}
}

/**
 * @title PredicateCrossCollateralRouterWrapperIntegrationTest
 * @notice Integration tests for the full transfer flow
 */
contract PredicateCrossCollateralRouterWrapperIntegrationTest is
    PredicateCrossCollateralRouterWrapperTest
{
    using TypeCasts for address;

    function test_integration_fullCrossChainTransferFlow() public {
        Attestation memory attestation = _createAttestation(
            "integration-uuid",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 bobBalanceBefore = primaryToken.balanceOf(BOB);

        bytes32 messageId = _approveAndTransferRemote(
            ALICE,
            TRANSFER_AMT,
            attestation
        );

        assertTrue(messageId != bytes32(0));
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
        assertFalse(predicateWrapper.pendingAttestation()); // Flag cleared

        remoteMailbox.processNextInboundMessage();

        assertEq(primaryToken.balanceOf(BOB), bobBalanceBefore + TRANSFER_AMT);
    }

    function test_integration_multipleSequentialTransfers() public {
        for (uint i = 0; i < 3; i++) {
            Attestation memory attestation = _createAttestation(
                string(abi.encodePacked("sequential-", vm.toString(i))),
                block.timestamp + 1 hours
            );
            _approveAndTransferRemote(ALICE, 10e18, attestation);
        }

        for (uint i = 0; i < 3; i++) {
            remoteMailbox.processNextInboundMessage();
        }

        assertEq(primaryToken.balanceOf(BOB), 30e18);
    }

    function test_integration_bypassAttemptAfterLegitTransfer() public {
        Attestation memory attestation = _createAttestation(
            "legit-transfer",
            block.timestamp + 1 hours
        );
        _approveAndTransferRemote(ALICE, TRANSFER_AMT, attestation);

        // Bypass attempt: call routerA directly
        vm.prank(ALICE);
        primaryToken.approve(address(routerA), TRANSFER_AMT);

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateCrossCollateralRouterWrapper
                .PredicateCrossCollateralRouterWrapper__UnauthorizedTransfer
                .selector
        );
        routerA.transferRemote{value: 0}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_integration_sameDomainAndCrossChainSequential() public {
        bytes32 targetRouter = address(routerC).addressToBytes32();

        // Same-domain transfer first
        Attestation memory att1 = _createAttestation(
            "same-domain-1",
            block.timestamp + 1 hours
        );
        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT * 2);
        predicateWrapper.transferRemoteToWithAttestation{value: 0}(
            att1,
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            targetRouter
        );
        vm.stopPrank();

        assertEq(destToken.balanceOf(BOB), TRANSFER_AMT);

        // Cross-chain transfer second
        Attestation memory att2 = _createAttestation(
            "cross-chain-2",
            block.timestamp + 1 hours
        );
        vm.startPrank(ALICE);
        predicateWrapper.transferRemoteToWithAttestation{value: 0}(
            att2,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            address(routerB).addressToBytes32()
        );
        vm.stopPrank();

        remoteMailbox.processNextInboundMessage();
        assertEq(primaryToken.balanceOf(BOB), TRANSFER_AMT);
    }
}

/// @notice Helper contract that rejects ETH refunds to test RefundFailed path
contract CCRRefundRejecter {
    PredicateCrossCollateralRouterWrapper public wrapper;
    ERC20Test internal token;

    constructor(PredicateCrossCollateralRouterWrapper _wrapper) {
        wrapper = _wrapper;
        token = ERC20Test(address(_wrapper.token()));
    }

    function doTransferRemote(
        Attestation calldata _attestation,
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable {
        token.approve(address(wrapper), _amount);
        wrapper.transferRemoteWithAttestation{value: msg.value}(
            _attestation,
            _destination,
            _recipient,
            _amount
        );
    }

    // No receive() or fallback() — ETH refunds will fail
}
