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
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {PredicateRouterWrapper} from "../../contracts/token/extensions/PredicateRouterWrapper.sol";
import {IPredicateRegistry, Statement, Attestation} from "@predicate/interfaces/IPredicateRegistry.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice Minimal interface for PredicateRegistry admin functions not in IPredicateRegistry
interface IPredicateRegistryAdmin {
    function owner() external view returns (address);
    function registerAttester(address attester) external;
}

/**
 * @title PredicateRouterWrapperForkTest
 * @notice Fork tests using the real Predicate Registry on Base with real cryptographic validation
 * @dev Registers a test attester on the real registry and uses real ECDSA signatures
 *      to validate attestations - no mocking of validateAttestation
 * @dev Cancun EVM version required to avoid `NotActivated` errors on Base fork
 * forge-config: default.evm_version = "cancun"
 */
contract PredicateRouterWrapperForkTest is Test {
    using TypeCasts for address;

    // ============ Constants ============

    /// @notice Real Predicate Registry address (deployed on Base and Mainnet)
    address internal constant PREDICATE_REGISTRY =
        0xe15a8Ca5BD8464283818088c1760d8f23B6a216E;

    uint32 internal constant ORIGIN = 8453; // Base chain ID
    uint32 internal constant DESTINATION = 1; // Mainnet
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 internal constant TRANSFER_AMT = 100e18;
    string internal constant NAME = "TestToken";
    string internal constant SYMBOL = "TEST";
    string internal constant POLICY_ID = "x-predicate-test-policy";
    address internal constant PROXY_ADMIN = address(0x37);

    // Test addresses (using addresses > 0xFF to avoid precompile conflicts)
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    // ============ State ============

    uint256 internal baseFork;

    ERC20Test internal primaryToken;
    HypERC20Collateral internal collateralRouter;
    HypERC20 internal remoteToken;
    PredicateRouterWrapper internal predicateWrapper;
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;

    // Attester keypair for signing real attestations
    uint256 internal attesterPrivateKey;
    address internal attester;

    // ============ Events ============

    event TransferAuthorized(
        address indexed sender,
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        string uuid
    );

    // ============ Setup ============

    function setUp() public {
        // Create fork from Base - use env var or fallback to public RPC
        string memory baseRpcUrl = vm.envOr(
            "RPC_URL_BASE",
            string("https://mainnet.base.org")
        );
        baseFork = vm.createFork(baseRpcUrl);
        vm.selectFork(baseFork);

        // Verify the registry exists on this fork
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(PREDICATE_REGISTRY)
        }
        require(codeSize > 0, "Predicate Registry not found on Base fork");

        // Setup mailboxes (these are mocked, not forked)
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

        // Deploy predicate wrapper with REAL registry address
        // Token address is fetched from warpRoute.token()
        // Note: No need to mock setPolicyID - the real registry allows any client to set their policy
        predicateWrapper = new PredicateRouterWrapper(
            address(collateralRouter),
            PREDICATE_REGISTRY,
            POLICY_ID
        );

        // Set predicate wrapper as hook on the warp route
        collateralRouter.setHook(address(predicateWrapper));

        // Fund accounts
        primaryToken.transfer(address(collateralRouter), 500_000e18);
        primaryToken.transfer(ALICE, 100_000e18);
        vm.deal(ALICE, 10 ether);

        // Create attester keypair for signing real attestations
        (attester, attesterPrivateKey) = makeAddrAndKey("fork-test-attester");

        // Register attester on the real registry by pranking as owner
        address registryOwner = IPredicateRegistryAdmin(PREDICATE_REGISTRY)
            .owner();
        vm.prank(registryOwner);
        IPredicateRegistryAdmin(PREDICATE_REGISTRY).registerAttester(attester);
    }

    // ============ Helper Functions ============

    /// @notice Generate a unique UUID for each test to avoid replay protection conflicts
    function _generateUUID(
        string memory salt
    ) internal view returns (string memory) {
        return
            vm.toString(
                uint256(
                    keccak256(abi.encode(block.timestamp, block.number, salt))
                )
            );
    }

    /// @notice Create a signed attestation using the registered attester's private key
    /// @dev Computes the hash using the same logic as PredicateRegistry.hashStatementWithExpiry
    function _createSignedAttestation(
        string memory uuid,
        uint256 expiration,
        address sender,
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) internal view returns (Attestation memory) {
        bytes memory encodedSigAndArgs = abi.encodeWithSignature(
            "transferRemote(uint32,bytes32,uint256)",
            destination,
            recipient,
            amount
        );

        // Compute hash using same logic as PredicateRegistry.hashStatementWithExpiry
        // When target == msg.sender (the wrapper calling validateAttestation), this matches hashStatementSafe
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                uuid,
                sender,
                address(predicateWrapper), // target - must match msg.sender at validation time
                uint256(0), // msgValue
                encodedSigAndArgs,
                POLICY_ID,
                expiration
            )
        );

        // Sign with attester's private key
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterPrivateKey, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        return
            Attestation({
                uuid: uuid,
                expiration: expiration,
                attester: attester,
                signature: signature
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

    // ============ Fork Verification Tests ============

    function test_fork_registryExists() public view {
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(PREDICATE_REGISTRY)
        }
        assertGt(codeSize, 0, "Registry should have code");
    }

    function test_fork_canCallRegistryOwner() public view {
        // Test direct staticcall to registry's owner() function
        address owner = IPredicateRegistryAdmin(PREDICATE_REGISTRY).owner();
        assertEq(
            owner,
            0x62ca17e47cC2EFF4a81FC0E173cAfCb1B840635F,
            "Owner should match expected"
        );
    }

    function test_fork_wrapperUsesRealRegistry() public view {
        assertEq(
            predicateWrapper.getRegistry(),
            PREDICATE_REGISTRY,
            "Wrapper should use real registry"
        );
    }

    function test_fork_policyRegistered() public view {
        assertEq(
            predicateWrapper.getPolicyID(),
            POLICY_ID,
            "Policy should be set"
        );
    }

    // ============ Transfer Tests with Real Cryptographic Validation ============

    function test_fork_transfer_success() public {
        string memory uuid = _generateUUID("success");
        uint256 expiration = block.timestamp + 1 hours;

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
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

        assertTrue(messageId != bytes32(0), "Message ID should be non-zero");
        assertEq(
            primaryToken.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT,
            "Alice balance should decrease"
        );
        assertEq(
            primaryToken.balanceOf(address(collateralRouter)),
            routerBalanceBefore + TRANSFER_AMT,
            "Router balance should increase"
        );
    }

    function test_fork_transfer_emitsEvent() public {
        string memory uuid = _generateUUID("events");
        uint256 expiration = block.timestamp + 1 hours;

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        vm.startPrank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        vm.expectEmit(true, true, true, true);
        emit TransferAuthorized(
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            uuid
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

    function test_fork_transfer_processesOnRemote() public {
        string memory uuid = _generateUUID("remote");
        uint256 expiration = block.timestamp + 1 hours;

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        // Process the message on remote
        remoteMailbox.processNextInboundMessage();

        assertEq(
            remoteToken.balanceOf(BOB),
            TRANSFER_AMT,
            "Bob should receive tokens on remote"
        );
    }

    function test_fork_transfer_clearsPendingFlag() public {
        string memory uuid = _generateUUID("flag");
        uint256 expiration = block.timestamp + 1 hours;

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        assertFalse(
            predicateWrapper.pendingAttestation(),
            "Flag should be false before"
        );

        _approveAndTransfer(ALICE, TRANSFER_AMT, attestation);

        assertFalse(
            predicateWrapper.pendingAttestation(),
            "Flag should be cleared after"
        );
    }

    // ============ Validation Failure Tests ============

    function test_fork_transferReverts_whenAttesterNotRegistered() public {
        string memory uuid = _generateUUID("unregistered-attester");
        uint256 expiration = block.timestamp + 1 hours;

        // Create a different attester keypair that is NOT registered
        (
            address unregisteredAttester,
            uint256 unregisteredKey
        ) = makeAddrAndKey("unregistered-attester");

        // Sign with the unregistered attester
        bytes memory encodedSigAndArgs = abi.encodeWithSignature(
            "transferRemote(uint32,bytes32,uint256)",
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
        bytes32 digest = keccak256(
            abi.encode(
                block.chainid,
                uuid,
                ALICE,
                address(predicateWrapper),
                uint256(0),
                encodedSigAndArgs,
                POLICY_ID,
                expiration
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(unregisteredKey, digest);

        Attestation memory attestation = Attestation({
            uuid: uuid,
            expiration: expiration,
            attester: unregisteredAttester,
            signature: abi.encodePacked(r, s, v)
        });

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert(
            "Predicate.validateAttestation: Attester is not a registered attester"
        );
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_fork_transferReverts_whenExpired() public {
        string memory uuid = _generateUUID("expired");
        uint256 expiration = block.timestamp - 1; // Already expired

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        vm.prank(ALICE);
        primaryToken.approve(address(predicateWrapper), TRANSFER_AMT);

        uint256 requiredValue = noopHook.quoteDispatch("", "");

        vm.prank(ALICE);
        vm.expectRevert("Predicate.validateAttestation: attestation expired");
        predicateWrapper.transferRemoteWithAttestation{value: requiredValue}(
            attestation,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    // ============ Bypass Prevention Tests on Fork ============

    function test_fork_bypassPrevention_directTransferReverts() public {
        // Fund Alice with tokens and give her allowance on the router directly
        vm.prank(ALICE);
        primaryToken.approve(address(collateralRouter), TRANSFER_AMT);

        // Alice tries to bypass the wrapper by calling collateralRouter.transferRemote() directly
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

    function test_fork_bypassAttemptAfterLegitTransfer() public {
        // First, do a legitimate transfer with real attestation
        string memory uuid = _generateUUID("legit-transfer");
        uint256 expiration = block.timestamp + 1 hours;

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
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

    // ============ Multiple Sequential Transfers ============

    function test_fork_multipleSequentialTransfers() public {
        uint256 transferAmount = 10e18;

        for (uint256 i = 0; i < 3; i++) {
            string memory uuid = _generateUUID(
                string(abi.encodePacked("sequential-", vm.toString(i)))
            );
            uint256 expiration = block.timestamp + 1 hours;

            Attestation memory attestation = _createSignedAttestation(
                uuid,
                expiration,
                ALICE,
                DESTINATION,
                BOB.addressToBytes32(),
                transferAmount
            );

            _approveAndTransfer(ALICE, transferAmount, attestation);
        }

        // Process all messages
        for (uint256 i = 0; i < 3; i++) {
            remoteMailbox.processNextInboundMessage();
        }

        assertEq(
            remoteToken.balanceOf(BOB),
            30e18,
            "Bob should receive all tokens"
        );
    }

    // ============ Admin Functions on Fork ============

    function test_fork_setPolicyID_updatesRegistry() public {
        string memory newPolicy = "x-new-fork-policy";

        // No mock needed - the real registry allows any client to set their policy
        predicateWrapper.setPolicyID(newPolicy);

        assertEq(
            predicateWrapper.getPolicyID(),
            newPolicy,
            "Policy should be updated"
        );
    }

    function test_fork_setRegistry_canChangeRegistry() public {
        address newRegistry = address(0xBEEF);

        // Mock setPolicyID on new registry
        vm.mockCall(
            newRegistry,
            abi.encodeWithSelector(
                IPredicateRegistry.setPolicyID.selector,
                POLICY_ID
            ),
            abi.encode()
        );

        predicateWrapper.setRegistry(newRegistry);

        assertEq(
            predicateWrapper.getRegistry(),
            newRegistry,
            "Registry should be updated"
        );
    }
}

/**
 * @title PredicateRouterWrapperForkIntegrationTest
 * @notice Integration tests demonstrating full flow on Base fork with real cryptographic validation
 * @dev Cancun EVM version required to avoid `NotActivated` errors on Base fork
 * forge-config: default.evm_version = "cancun"
 */
contract PredicateRouterWrapperForkIntegrationTest is
    PredicateRouterWrapperForkTest
{
    using TypeCasts for address;
    function test_fork_integration_fullTransferFlow() public {
        // This test demonstrates the complete flow on a real fork:
        // 1. User gets attestation signed by registered attester
        // 2. User calls wrapper
        // 3. Wrapper validates via real registry with real ECDSA verification
        // 4. Wrapper transfers tokens, calls warp route
        // 5. Hook verifies flag, clears it
        // 6. Message arrives on destination

        string memory uuid = _generateUUID("integration-full-flow");
        uint256 expiration = block.timestamp + 1 hours;

        Attestation memory attestation = _createSignedAttestation(
            uuid,
            expiration,
            ALICE,
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        uint256 aliceBalanceBefore = primaryToken.balanceOf(ALICE);
        uint256 bobBalanceBefore = remoteToken.balanceOf(BOB);

        // Step 1-5: Transfer via wrapper with real attestation validation
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

        // Step 6: Process on destination
        remoteMailbox.processNextInboundMessage();

        // Verify final state
        assertEq(remoteToken.balanceOf(BOB), bobBalanceBefore + TRANSFER_AMT);
    }

    function test_fork_integration_realRegistryInterface() public view {
        // Verify we're interacting with the real registry's interface
        // by checking it implements the expected functions

        // Check the registry has the expected interface by checking code exists
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(PREDICATE_REGISTRY)
        }
        assertGt(codeSize, 0, "Registry should have code");

        // The wrapper should point to the real registry
        assertEq(
            predicateWrapper.getRegistry(),
            PREDICATE_REGISTRY,
            "Should use real registry address"
        );
    }

    function test_fork_integration_attesterIsRegistered() public view {
        // Verify our test attester was successfully registered on the real registry
        (bool success, bytes memory data) = PREDICATE_REGISTRY.staticcall(
            abi.encodeWithSignature("isAttesterRegistered(address)", attester)
        );
        assertTrue(success, "Call should succeed");
        assertTrue(abi.decode(data, (bool)), "Attester should be registered");
    }
}
