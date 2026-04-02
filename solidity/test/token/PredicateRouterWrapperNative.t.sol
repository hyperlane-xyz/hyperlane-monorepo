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
import {HypNative} from "../../contracts/token/HypNative.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {PredicateRouterWrapper} from "../../contracts/token/extensions/PredicateRouterWrapper.sol";
import {IPredicateWrapper} from "../../contracts/interfaces/IPredicateWrapper.sol";
import {Statement, Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * @title PredicateRouterWrapperNativeTest
 * @notice Tests PredicateRouterWrapper with native token (HypNative) warp routes
 */
contract PredicateRouterWrapperNativeTest is Test {
    using TypeCasts for address;

    // Constants
    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 1 ether;
    string internal constant POLICY_ID = "native-policy-123";
    address internal constant PROXY_ADMIN = address(0x37);

    // Addresses
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);
    address internal constant ATTESTER = address(0x3);

    // Contracts
    HypNative internal nativeRouter;
    HypERC20 internal remoteToken;
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

        // Deploy native router
        nativeRouter = new HypNative(SCALE, SCALE, address(localMailbox));
        nativeRouter.initialize(
            address(noopHook),
            address(0), // ISM
            address(this) // owner
        );

        // Deploy remote synthetic token
        HypERC20 implementation = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                "Native",
                "NAT",
                address(noopHook),
                address(0),
                address(this)
            )
        );
        remoteToken = HypERC20(address(proxy));

        // Enroll routers
        nativeRouter.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(nativeRouter).addressToBytes32()
        );

        // Deploy mock predicate registry
        registry = new MockPredicateRegistry();
        registry.registerAttester(ATTESTER);

        // Deploy predicate wrapper
        predicateWrapper = new PredicateRouterWrapper(
            address(nativeRouter),
            address(registry),
            POLICY_ID
        );

        // Set predicate wrapper as hook on the warp route
        nativeRouter.setHook(address(predicateWrapper));

        // Fund accounts
        vm.deal(address(nativeRouter), 100 ether);
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

    // ============ Constructor Tests ============

    function test_constructor_native_setsToken() public view {
        // For native tokens, token() should return address(0)
        assertEq(address(predicateWrapper.token()), address(0));
    }

    function test_constructor_native_noApprovalNeeded() public view {
        // Constructor should skip approval for native tokens
        // (No way to verify directly, but shouldn't revert)
        assertEq(address(predicateWrapper.warpRoute()), address(nativeRouter));
    }

    // ============ Transfer Tests ============

    function test_native_transferRemoteWithAttestation_success() public {
        Attestation memory attestation = _createAttestation(
            "native-uuid-1",
            block.timestamp + 1 hours
        );

        uint256 aliceBalanceBefore = ALICE.balance;
        uint256 routerBalanceBefore = address(nativeRouter).balance;

        // Calculate total value needed (amount + gas)
        uint256 gasValue = noopHook.quoteDispatch("", "");
        uint256 totalValue = TRANSFER_AMT + gasValue;

        vm.prank(ALICE);
        bytes32 messageId = predicateWrapper.transferRemoteWithAttestation{
            value: totalValue
        }(attestation, DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT);

        assertTrue(messageId != bytes32(0));
        // Alice pays transfer amount + gas
        assertEq(ALICE.balance, aliceBalanceBefore - totalValue);
        // Router receives the transfer amount
        assertEq(
            address(nativeRouter).balance,
            routerBalanceBefore + TRANSFER_AMT
        );
    }

    function test_native_transferRemoteWithAttestation_emitsEvents() public {
        Attestation memory attestation = _createAttestation(
            "native-events",
            block.timestamp + 1 hours
        );

        uint256 gasValue = noopHook.quoteDispatch("", "");
        uint256 totalValue = TRANSFER_AMT + gasValue;

        vm.prank(ALICE);
        vm.expectEmit(true, true, true, true);
        emit TransferAuthorized(
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            "native-events"
        );

        predicateWrapper.transferRemoteWithAttestation{value: totalValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_native_transferRemoteWithAttestation_processesOnRemote()
        public
    {
        Attestation memory attestation = _createAttestation(
            "native-uuid-2",
            block.timestamp + 1 hours
        );

        uint256 gasValue = noopHook.quoteDispatch("", "");
        uint256 totalValue = TRANSFER_AMT + gasValue;

        vm.prank(ALICE);
        predicateWrapper.transferRemoteWithAttestation{value: totalValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Process the message on remote
        remoteMailbox.processNextInboundMessage();

        // BOB receives minted synthetic tokens on destination
        assertEq(remoteToken.balanceOf(BOB), TRANSFER_AMT);
    }

    function test_native_revert_ifInsufficientValue() public {
        Attestation memory attestation = _createAttestation(
            "native-insufficient",
            block.timestamp + 1 hours
        );

        uint256 gasValue = noopHook.quoteDispatch("", "");
        // Send only gas value, not enough for transfer amount
        uint256 insufficientValue = gasValue + TRANSFER_AMT - 1;

        vm.prank(ALICE);
        vm.expectRevert(
            IPredicateWrapper.IPredicateWrapper__InsufficientValue.selector
        );
        predicateWrapper.transferRemoteWithAttestation{
            value: insufficientValue
        }(attestation, DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT);
    }

    function test_native_acceptsExcessValue() public {
        Attestation memory attestation = _createAttestation(
            "native-excess",
            block.timestamp + 1 hours
        );

        uint256 gasValue = noopHook.quoteDispatch("", "");
        // Send more than needed (excess goes to gas payment)
        uint256 excessValue = TRANSFER_AMT + gasValue + 1 ether;

        uint256 aliceBalanceBefore = ALICE.balance;

        vm.prank(ALICE);
        bytes32 messageId = predicateWrapper.transferRemoteWithAttestation{
            value: excessValue
        }(attestation, DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT);

        assertTrue(messageId != bytes32(0));
        // Alice is refunded the excess; only pays the required amount
        uint256 totalRequired = TRANSFER_AMT + gasValue;
        assertEq(ALICE.balance, aliceBalanceBefore - totalRequired);
    }

    function test_native_bypassPrevention_directTransferRemoteReverts() public {
        uint256 gasValue = noopHook.quoteDispatch("", "");
        uint256 totalValue = TRANSFER_AMT + gasValue;

        vm.prank(ALICE);
        vm.expectRevert(
            IPredicateWrapper.IPredicateWrapper__UnauthorizedTransfer.selector
        );
        nativeRouter.transferRemote{value: totalValue}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    // ============ Fuzz Tests ============

    function test_native_refundFailed_revertsIfCallerRejectsETH() public {
        // Deploy a contract that rejects ETH to simulate refund failure
        RefundRejecter rejecter = new RefundRejecter(predicateWrapper);
        vm.deal(address(rejecter), 10 ether);

        Attestation memory attestation = _createAttestation(
            "native-refund-fail",
            block.timestamp + 1 hours
        );

        uint256 gasValue = noopHook.quoteDispatch("", "");
        // Send excess so a refund is attempted
        uint256 excessValue = TRANSFER_AMT + gasValue + 1 ether;

        vm.expectRevert(
            IPredicateWrapper.IPredicateWrapper__RefundFailed.selector
        );
        rejecter.doTransfer{value: excessValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function testFuzz_native_transferRemoteWithAttestation_variableAmounts(
        uint256 amount
    ) public {
        amount = bound(amount, 0.01 ether, ALICE.balance / 2);

        Attestation memory attestation = _createAttestation(
            string(abi.encodePacked("native-fuzz-", vm.toString(amount))),
            block.timestamp + 1 hours
        );

        uint256 gasValue = noopHook.quoteDispatch("", "");
        uint256 totalValue = amount + gasValue;

        uint256 aliceBalanceBefore = ALICE.balance;

        vm.prank(ALICE);
        predicateWrapper.transferRemoteWithAttestation{value: totalValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            amount
        );

        assertEq(ALICE.balance, aliceBalanceBefore - totalValue);
    }
}

/// @notice Helper contract that rejects ETH refunds to test RefundFailed path
contract RefundRejecter {
    PredicateRouterWrapper public wrapper;

    constructor(PredicateRouterWrapper _wrapper) {
        wrapper = _wrapper;
    }

    function doTransfer(
        Attestation calldata _attestation,
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable {
        wrapper.transferRemoteWithAttestation{value: msg.value}(
            _attestation,
            _destination,
            _recipient,
            _amount
        );
    }

    // No receive() or fallback() — ETH refunds will fail
}
