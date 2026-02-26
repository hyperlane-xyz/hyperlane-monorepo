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
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {PredicateRouterWrapper} from "../../contracts/token/extensions/PredicateRouterWrapper.sol";
import {Statement, Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract PredicateRouterWrapperTest is Test {
    using TypeCasts for address;

    // Constants
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 100e18;
    string internal constant NAME = "TestToken";
    string internal constant SYMBOL = "TEST";
    string internal constant POLICY_ID = "test-policy-123";
    address internal constant PROXY_ADMIN = address(0x37);

    // Addresses
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant ATTESTER = address(0x3);

    // Contracts
    ERC20Test internal primaryToken;
    HypERC20Collateral internal collateralRouter;
    HypERC20 internal remoteToken;
    PredicateRouterWrapper internal predicateWrapper;
    MockPredicateRegistry internal registry;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;

    // Events (from PredicateClient)
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
        string uuid
    );
    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
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

        // Deploy token
        primaryToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);

        // Deploy collateral router
        collateralRouter = new HypERC20Collateral(
            address(primaryToken),
            SCALE,
            address(localMailbox)
        );
        collateralRouter.initialize(
            address(noopHook),
            address(0), // ISM
            address(this) // owner
        );

        // Deploy remote synthetic token
        HypERC20 implementation = new HypERC20(
            DECIMALS,
            SCALE,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                NAME,
                SYMBOL,
                address(noopHook),
                address(0),
                address(this)
            )
        );
        remoteToken = HypERC20(address(proxy));

        // Enroll routers
        collateralRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(collateralRouter).addressToBytes32()
        );

        // Deploy mock predicate registry
        registry = new MockPredicateRegistry();
        registry.registerAttester(ATTESTER);

        // Deploy predicate wrapper (deployer becomes owner)
        // Token address is fetched from warpRoute.token()
        predicateWrapper = new PredicateRouterWrapper(
            address(collateralRouter),
            address(registry),
            POLICY_ID
        );

        // Set predicate wrapper as hook on the warp route
        // This is the key configuration - the wrapper acts as both entry point AND hook
        collateralRouter.setHook(address(predicateWrapper));

        // Fund accounts
        primaryToken.transfer(address(collateralRouter), 500_000e18);
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
                signature: hex"" // Mock doesn't verify signatures
            });
    }

    function _approveAndTransfer(
        address sender,
        uint256 amount,
        Attestation memory attestation
    ) internal returns (bytes32) {
        vm.startPrank(sender);
        primaryToken.approve(address(predicateWrapper), amount);
        uint256 requiredValue = noopHook.quoteDispatch("", "");
        bytes32 messageId = predicateWrapper.transferRemoteWithAttestation{
            value: requiredValue
        }(attestation, DESTINATION, BOB.addressToBytes32(), amount);
        vm.stopPrank();
        return messageId;
    }

    // ============ Constructor Tests ============

    function test_constructor_setsWarpRoute() public view {
        assertEq(
            address(predicateWrapper.warpRoute()),
            address(collateralRouter)
        );
    }

    function test_constructor_setsToken() public view {
        assertEq(address(predicateWrapper.token()), address(primaryToken));
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

    function test_constructor_revert_ifZeroRegistry() public {
        vm.expectRevert(
            PredicateRouterWrapper
                .PredicateRouterWrapper__InvalidRegistry
                .selector
        );
        new PredicateRouterWrapper(
            address(collateralRouter),
            address(0),
            POLICY_ID
        );
    }

    function test_constructor_revert_ifEmptyPolicy() public {
        vm.expectRevert(
            PredicateRouterWrapper
                .PredicateRouterWrapper__InvalidPolicy
                .selector
        );
        new PredicateRouterWrapper(
            address(collateralRouter),
            address(registry),
            ""
        );
    }

    // ============ Transfer Tests ============

    function test_transferRemoteWithAttestation_success() public {
        Attestation memory attestation = _createAttestation(
            "test-uuid-1",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 routerBalanceBefore = primaryToken.balanceOf(
            address(collateralRouter)
        );

        bytes32 messageId = _approveAndTransfer(
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
            primaryToken.balanceOf(address(collateralRouter)),
            routerBalanceBefore + TRANSFER_AMT
        );
    }

    function test_transferRemoteWithAttestation_emitsEvents() public {
        Attestation memory attestation = _createAttestation(
            "test-uuid-events",
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
            "test-uuid-events"
        );

        uint256 requiredValue = noopHook.quoteDispatch("", "");
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        vm.stopPrank();
    }

    function test_transferRemoteWithAttestation_processesOnRemote() public {
        Attestation memory attestation = _createAttestation(
            "test-uuid-2",
            block.timestamp + 1 hours
        );

        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // Process the message on remote
        remoteMailbox.processNextInboundMessage();

        assertEq(remoteToken.balanceOf(BOB), TRANSFER_AMT);
    }

    function test_transferRemoteWithAttestation_clearsPendingFlag() public {
        Attestation memory attestation = _createAttestation(
            "test-uuid-flag",
            block.timestamp + 1 hours
        );

        // Before transfer, flag should be false
        assertFalse(predicateWrapper.pendingAttestation());

        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // After transfer, flag should be cleared (false)
        assertFalse(predicateWrapper.pendingAttestation());
    }

    function test_transferRemoteWithAttestation_revert_ifValidationFails()
        public
    {
        Attestation memory attestation = _createAttestation(
            "test-uuid-3",
            block.timestamp + 1 hours
        );

        registry.setShouldValidate(false);

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateRouterWrapper
                .PredicateRouterWrapper__AttestationInvalid
                .selector
        );
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
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
            "test-uuid-4",
            block.timestamp + 1 hours
        );

        registry.setShouldRevert(true, "Attestation expired");

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert("Attestation expired");
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
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

        // First transfer succeeds
        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // Second transfer with same UUID fails
        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert("MockPredicateRegistry: UUID already used");
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
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
            "test-uuid-5",
            block.timestamp + 1 hours
        );

        // Don't approve tokens
        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert();
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
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
            "test-uuid-6",
            block.timestamp + 1 hours
        );

        uint256 tooMuch = primaryToken.balanceOf(ALICE) + 1;

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), tooMuch);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert();
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            tooMuch
        );
    }

    // ============ Bypass Prevention Tests (Critical Security) ============

    function test_bypassPrevention_directTransferRemoteReverts() public {
        // Fund Alice with tokens and give her allowance on the router directly
        vm.prank(ALICE);
        primaryToken.approve(address(collateralRouter), TRANSFER_AMT);

        // Alice tries to bypass the wrapper by calling collateralRouter.transferRemote() directly
        // This should fail because the hook (predicateWrapper) will check pendingAttestation
        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateRouterWrapper
                .PredicateRouterWrapper__UnauthorizedTransfer
                .selector
        );
        collateralRouter.transferRemote{value: requiredValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_bypassPrevention_pendingFlagNotSetExternally() public {
        // The pendingAttestation flag is only set by transferRemoteWithAttestation
        // There's no way for external actors to set it
        assertFalse(predicateWrapper.pendingAttestation());

        // Even if someone could somehow set the flag, they can't call the protected function
        // because only the wrapper itself can set it during transferRemoteWithAttestation
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
        // No event should be emitted
        vm.recordLogs();
        predicateWrapper.setPolicyID(POLICY_ID);
        Vm.Log[] memory entries = vm.getRecordedLogs();

        // Only expect PolicySet from registry, not PredicatePolicyIDUpdated
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
            PredicateRouterWrapper
                .PredicateRouterWrapper__InvalidPolicy
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
        // Policy should be re-registered with new registry
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
            PredicateRouterWrapper
                .PredicateRouterWrapper__InvalidRegistry
                .selector
        );
        predicateWrapper.setRegistry(address(0));
    }

    // ============ Hook Interface Tests ============

    function test_hookType_returnsUnused() public view {
        assertEq(predicateWrapper.hookType(), 0); // UNUSED = 0
    }

    function test_quoteDispatch_returnsZero() public view {
        uint256 quote = predicateWrapper.quoteDispatch("", "");
        assertEq(quote, 0);
    }

    function test_supportsMetadata_returnsTrue() public view {
        assertTrue(predicateWrapper.supportsMetadata(""));
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

        _approveAndTransfer(ALICE, amount, attestation);

        assertEq(primaryToken.balanceOf(ALICE), aliceBalanceBefore - amount);
    }
}

/**
 * @title PredicateRouterWrapperIntegrationTest
 * @notice Integration tests demonstrating the full flow with mocked registry
 */
contract PredicateRouterWrapperIntegrationTest is PredicateRouterWrapperTest {
    using TypeCasts for address;

    function test_integration_fullTransferFlow() public {
        // This test demonstrates the complete flow:
        // 1. User gets attestation
        // 2. User calls wrapper
        // 3. Wrapper validates, sets flag, transfers tokens, calls warp route
        // 4. Warp route dispatches, mailbox calls hook
        // 5. Hook verifies flag, clears it
        // 6. Message arrives on destination
        // 7. Recipient receives tokens

        Attestation memory attestation = _createAttestation(
            "integration-uuid",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 bobBalanceBefore = remoteToken.balanceOf(BOB);

        // Step 1-5: Transfer via wrapper
        bytes32 messageId = _approveAndTransfer(
            ALICE,
            TRANSFER_AMT,
            attestation
        );
        assertTrue(messageId != bytes32(0));

        // Verify intermediate state
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
        assertFalse(predicateWrapper.pendingAttestation()); // Flag cleared

        // Step 6-7: Process on destination
        remoteMailbox.processNextInboundMessage();

        // Verify final state
        assertEq(remoteToken.balanceOf(BOB), bobBalanceBefore + TRANSFER_AMT);
    }

    function test_integration_multipleSequentialTransfers() public {
        // Multiple transfers should work sequentially
        for (uint i = 0; i < 3; i++) {
            Attestation memory attestation = _createAttestation(
                string(abi.encodePacked("sequential-", vm.toString(i))),
                block.timestamp + 1 hours
            );

            _approveAndTransfer(ALICE, 10e18, attestation);
        }

        // Process all messages
        for (uint i = 0; i < 3; i++) {
            remoteMailbox.processNextInboundMessage();
        }

        assertEq(remoteToken.balanceOf(BOB), 30e18);
    }

    function test_integration_bypassAttemptAfterLegitTransfer() public {
        // First, do a legitimate transfer
        Attestation memory attestation = _createAttestation(
            "legit-transfer",
            block.timestamp + 1 hours
        );
        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // Now try to bypass
        vm.prank(ALICE);
        primaryToken.approve(address(collateralRouter), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert(
            PredicateRouterWrapper
                .PredicateRouterWrapper__UnauthorizedTransfer
                .selector
        );
        collateralRouter.transferRemote{value: requiredValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }
}
