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
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {PredicateRouterWrapper} from "../../contracts/token/extensions/PredicateRouterWrapper.sol";
import {IPredicateWrapper} from "../../contracts/interfaces/IPredicateWrapper.sol";
import {Statement, Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @title PredicateRouterWrapperSyntheticTest
 * @notice Tests PredicateRouterWrapper with synthetic token (HypERC20) warp routes as origin
 * @dev Tests the case where HypERC20 is on the origin chain (burns on send, mints on receive)
 */
contract PredicateRouterWrapperSyntheticTest is Test {
    using TypeCasts for address;

    // Constants
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 100e18;
    string internal constant NAME = "SyntheticToken";
    string internal constant SYMBOL = "SYN";
    string internal constant POLICY_ID = "synthetic-policy-123";
    address internal constant PROXY_ADMIN = address(0x37);

    // Addresses
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant ATTESTER = address(0x3);

    // Contracts
    HypERC20 internal syntheticRouter;
    HypERC20Collateral internal remoteCollateralRouter;
    ERC20Test internal primaryToken;
    PredicateRouterWrapper internal predicateWrapper;
    MockPredicateRegistry internal registry;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;

    // Events
    event TransferAuthorized(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        string uuid
    );

    function setUp() public {
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

        // Deploy synthetic token on origin (this is the key difference from collateral test)
        HypERC20 implementation = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(localMailbox)
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
        syntheticRouter = HypERC20(address(proxy));

        // Deploy primary token and collateral router on destination
        primaryToken = new ERC20Test(NAME, SYMBOL, TOTAL_SUPPLY, DECIMALS);
        remoteCollateralRouter = new HypERC20Collateral(
            address(primaryToken),
            SCALE,
            SCALE,
            address(remoteMailbox)
        );
        remoteCollateralRouter.initialize(
            address(noopHook),
            address(0),
            address(this)
        );

        // Enroll routers
        syntheticRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteCollateralRouter).addressToBytes32()
        );
        remoteCollateralRouter.enrollRemoteRouter(
            ORIGIN,
            address(syntheticRouter).addressToBytes32()
        );

        // Deploy mock predicate registry
        registry = new MockPredicateRegistry();
        registry.registerAttester(ATTESTER);

        // Deploy predicate wrapper
        predicateWrapper = new PredicateRouterWrapper(
            address(syntheticRouter),
            address(registry),
            POLICY_ID
        );

        // Set predicate wrapper as hook on the warp route
        syntheticRouter.setHook(address(predicateWrapper));

        // Fund accounts
        // For synthetics, tokens are minted to users directly
        syntheticRouter.transfer(ALICE, 100_000e18);
        // Fund remote collateral router with primary tokens
        primaryToken.transfer(address(remoteCollateralRouter), 500_000e18);
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

    function _approveAndTransfer(
        address sender,
        uint256 amount,
        Attestation memory attestation
    ) internal returns (bytes32) {
        vm.startPrank(sender);
        syntheticRouter.approve(address(predicateWrapper), amount);
        uint256 requiredValue = noopHook.quoteDispatch("", "");
        bytes32 messageId = predicateWrapper.transferRemoteWithAttestation{
            value: requiredValue
        }(attestation, DESTINATION, BOB.addressToBytes32(), amount);
        vm.stopPrank();
        return messageId;
    }

    // ============ Constructor Tests ============

    function test_constructor_synthetic_setsToken() public view {
        // For synthetic tokens, token() returns the router address itself
        assertEq(address(predicateWrapper.token()), address(syntheticRouter));
    }

    function test_constructor_synthetic_noApprovalNeeded() public view {
        // Constructor should skip approval for synthetic tokens
        // (token address == warpRoute address)
        assertEq(
            address(predicateWrapper.warpRoute()),
            address(syntheticRouter)
        );
    }

    // ============ Transfer Tests ============

    function test_synthetic_transferRemoteWithAttestation_success() public {
        Attestation memory attestation = _createAttestation(
            "synthetic-uuid-1",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = syntheticRouter.balanceOf(ALICE);
        uint256 totalSupplyBefore = syntheticRouter.totalSupply();

        bytes32 messageId = _approveAndTransfer(
            ALICE,
            TRANSFER_AMT,
            attestation
        );

        assertTrue(messageId != bytes32(0));
        // Alice's synthetic tokens are burned
        assertEq(
            syntheticRouter.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
        // Total supply decreases (tokens burned)
        assertEq(
            syntheticRouter.totalSupply(),
            totalSupplyBefore - TRANSFER_AMT
        );
    }

    function test_synthetic_transferRemoteWithAttestation_emitsEvents() public {
        Attestation memory attestation = _createAttestation(
            "synthetic-events",
            block.timestamp + 1 hours
        );

        vm.startPrank(ALICE);
        syntheticRouter.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.expectEmit(true, true, true, true);
        emit TransferAuthorized(
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            "synthetic-events"
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

    function test_synthetic_transferRemoteWithAttestation_processesOnRemote()
        public
    {
        Attestation memory attestation = _createAttestation(
            "synthetic-uuid-2",
            block.timestamp + 1 hours
        );

        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // Process the message on remote
        remoteMailbox.processNextInboundMessage();

        // BOB receives primary tokens on destination (unlocked from collateral)
        assertEq(primaryToken.balanceOf(BOB), TRANSFER_AMT);
    }

    function test_synthetic_transferRemoteWithAttestation_burnsMechanismWorks()
        public
    {
        Attestation memory attestation = _createAttestation(
            "synthetic-burn",
            block.timestamp + 1 hours
        );

        uint256 totalSupplyBefore = syntheticRouter.totalSupply();
        uint256 aliceBalanceBefore = syntheticRouter.balanceOf(ALICE);

        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // Verify burn happened
        assertEq(
            syntheticRouter.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT
        );
        assertEq(
            syntheticRouter.totalSupply(),
            totalSupplyBefore - TRANSFER_AMT
        );
        // Router should have zero balance (tokens are burned, not held)
        assertEq(syntheticRouter.balanceOf(address(syntheticRouter)), 0);
    }

    function test_synthetic_revert_ifInsufficientAllowance() public {
        Attestation memory attestation = _createAttestation(
            "synthetic-allowance",
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

    function test_synthetic_revert_ifInsufficientBalance() public {
        Attestation memory attestation = _createAttestation(
            "synthetic-balance",
            block.timestamp + 1 hours
        );

        uint256 tooMuch = syntheticRouter.balanceOf(ALICE) + 1;

        vm.prank(ALICE);
        syntheticRouter.approve(address(predicateWrapper), tooMuch);

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

    function test_synthetic_bypassPrevention_directTransferRemoteReverts()
        public
    {
        vm.prank(ALICE);
        syntheticRouter.approve(address(syntheticRouter), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert(
            IPredicateWrapper.PredicateWrapper__UnauthorizedTransfer.selector
        );
        syntheticRouter.transferRemote{value: requiredValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    // ============ Fuzz Tests ============

    function testFuzz_synthetic_transferRemoteWithAttestation_variableAmounts(
        uint256 amount
    ) public {
        amount = bound(amount, 1, syntheticRouter.balanceOf(ALICE));

        Attestation memory attestation = _createAttestation(
            string(abi.encodePacked("synthetic-fuzz-", vm.toString(amount))),
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = syntheticRouter.balanceOf(ALICE);
        uint256 totalSupplyBefore = syntheticRouter.totalSupply();

        _approveAndTransfer(ALICE, amount, attestation);

        assertEq(syntheticRouter.balanceOf(ALICE), aliceBalanceBefore - amount);
        assertEq(syntheticRouter.totalSupply(), totalSupplyBefore - amount);
    }

    // ============ Integration Test ============

    function test_synthetic_integration_roundTripTransfer() public {
        // Step 1: Transfer from origin (synthetic) to destination (collateral)
        Attestation memory attestation1 = _createAttestation(
            "roundtrip-1",
            block.timestamp + 1 hours
        );

        uint256 aliceOriginBalanceBefore = syntheticRouter.balanceOf(ALICE);
        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation1);

        // Process on destination
        remoteMailbox.processNextInboundMessage();
        assertEq(primaryToken.balanceOf(BOB), TRANSFER_AMT);

        // Verify burn on origin
        assertEq(
            syntheticRouter.balanceOf(ALICE),
            aliceOriginBalanceBefore - TRANSFER_AMT
        );
    }
}
