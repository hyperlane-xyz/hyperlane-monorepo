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
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TokenMessage} from "../../contracts/token/libs/TokenMessage.sol";
import {HypTIP20Collateral} from "../../contracts/token/extensions/HypTIP20Collateral.sol";
import {MockTIP20} from "./MockTIP20.sol";
import {MockTIP403Registry} from "./MockTIP403Registry.sol";

contract HypTIP20CollateralTest is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TOTAL_SUPPLY = 1_000_000e6; // TIP-20 uses 6 decimals
    uint256 internal constant TRANSFER_AMT = 100e6;
    string internal constant NAME = "TIP20Token";
    string internal constant SYMBOL = "TIP";
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);

    MockTIP20 internal tip20Token;
    MockTIP403Registry internal tip403Registry;
    HypTIP20Collateral internal localToken;
    HypTIP20Collateral internal remoteToken;
    HypTIP20Collateral internal localTokenNoRegistry; // Version without TIP-403
    MockMailbox internal localMailbox;
    MockMailbox internal remoteMailbox;
    TestPostDispatchHook internal noopHook;
    uint256 internal REQUIRED_VALUE;

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    event SentTransferRemoteWithMemo(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 memo
    );

    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount
    );

    event ReceivedTransferRemoteWithMemo(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount,
        bytes32 memo
    );

    event MintWithMemo(
        address indexed to,
        uint256 amount,
        bytes32 indexed memo
    );

    function setUp() public {
        // Deploy mailboxes
        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        // Deploy hooks
        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        REQUIRED_VALUE = noopHook.quoteDispatch("", "");

        // Deploy TIP-20 token
        tip20Token = new MockTIP20(NAME, SYMBOL);

        // Deploy TIP-403 registry
        tip403Registry = new MockTIP403Registry();

        // Deploy HypTIP20Collateral with registry
        localToken = new HypTIP20Collateral(
            address(tip20Token),
            address(tip403Registry),
            SCALE,
            address(localMailbox)
        );

        // Deploy remote HypTIP20Collateral
        MockTIP20 remoteTip20 = new MockTIP20(NAME, SYMBOL);
        remoteToken = new HypTIP20Collateral(
            address(remoteTip20),
            address(tip403Registry),
            SCALE,
            address(remoteMailbox)
        );
        // Transfer ownership of remote token to HypTIP20Collateral so it can mint
        remoteTip20.transferOwnership(address(remoteToken));

        // Deploy HypTIP20Collateral without registry (for testing disabled TIP-403)
        localTokenNoRegistry = new HypTIP20Collateral(
            address(tip20Token),
            address(0), // No registry
            SCALE,
            address(localMailbox)
        );

        // Enroll routers
        localToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );
        localTokenNoRegistry.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        // Mint tokens to Alice and approve HypTIP20
        tip20Token.mint(ALICE, TOTAL_SUPPLY);
        vm.prank(ALICE);
        tip20Token.approve(address(localToken), type(uint256).max);
        vm.prank(ALICE);
        tip20Token.approve(address(localTokenNoRegistry), type(uint256).max);

        // Fund Alice with ETH for gas
        vm.deal(ALICE, 1 ether);
    }

    function test_transferRemote_basic() public {
        uint256 aliceBalanceBefore = tip20Token.balanceOf(ALICE);
        uint256 contractBalanceBefore = tip20Token.balanceOf(
            address(localToken)
        );

        // transferRemote delegates to transferRemoteWithMemo with empty memo
        vm.expectEmit(true, true, false, true);
        emit SentTransferRemoteWithMemo(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            bytes32(0)
        );

        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Verify tokens were burned (transferred to contract then burned)
        assertEq(
            tip20Token.balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT,
            "Alice balance should decrease"
        );
        // Contract should not hold tokens (they were burned)
        assertEq(
            tip20Token.balanceOf(address(localToken)),
            contractBalanceBefore,
            "Contract should not hold tokens after burn"
        );
        assertTrue(messageId != bytes32(0), "Message ID should be non-zero");
    }

    function test_transferRemoteWithMemo() public {
        bytes32 memo = bytes32("INVOICE123");

        vm.expectEmit(true, true, false, true);
        emit SentTransferRemoteWithMemo(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            memo
        );

        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemoteWithMemo{
            value: REQUIRED_VALUE
        }(DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT, memo);

        assertTrue(messageId != bytes32(0), "Message ID should be non-zero");
    }

    function test_handle_basic() public {
        // Prepare message without memo
        bytes memory message = TokenMessage.format(
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            "" // No metadata
        );

        uint256 bobBalanceBefore = MockTIP20(remoteToken.token()).balanceOf(
            BOB
        );

        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            message
        );

        // Verify tokens were minted to Bob
        assertEq(
            MockTIP20(remoteToken.token()).balanceOf(BOB),
            bobBalanceBefore + TRANSFER_AMT,
            "Bob should receive tokens"
        );
    }

    function test_handle_withMemo() public {
        bytes32 memo = bytes32("PAYMENT456");

        // Prepare message with memo in metadata
        bytes memory message = TokenMessage.format(
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            abi.encodePacked(memo)
        );

        uint256 bobBalanceBefore = MockTIP20(remoteToken.token()).balanceOf(
            BOB
        );

        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            message
        );

        // Verify tokens were minted to Bob
        assertEq(
            MockTIP20(remoteToken.token()).balanceOf(BOB),
            bobBalanceBefore + TRANSFER_AMT,
            "Bob should receive tokens"
        );
    }

    function test_transferRemote_tip403Unauthorized() public {
        // Set policy ID to 2 (custom policy requiring authorization)
        tip20Token.setTransferPolicyId(2);

        // Alice is NOT authorized for policy 2
        // (MockTIP403Registry returns false for policy 2 by default)

        vm.expectRevert("TIP403: sender not authorized");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemote_tip403Authorized() public {
        // Set policy ID to 2 (custom policy requiring authorization)
        tip20Token.setTransferPolicyId(2);

        // Authorize Alice for policy 2
        tip403Registry.setAuthorized(2, ALICE, true);

        // Should succeed now
        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        assertTrue(messageId != bytes32(0), "Transfer should succeed");
    }

    function test_transferRemote_tip403Disabled() public {
        // Set policy ID to 2 (would require authorization)
        tip20Token.setTransferPolicyId(2);

        // Alice is NOT authorized, but using localTokenNoRegistry (no registry)
        // Should succeed because TIP-403 is disabled

        vm.prank(ALICE);
        bytes32 messageId = localTokenNoRegistry.transferRemote{
            value: REQUIRED_VALUE
        }(DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT);

        assertTrue(
            messageId != bytes32(0),
            "Transfer should succeed when registry is disabled"
        );
    }

    function test_transferRemote_pausedToken() public {
        // Pause the token
        tip20Token.pause();

        // Transfer should revert because burn() will fail on paused token
        vm.expectRevert("MockTIP20: token is paused");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_transferRemote_insufficientBalance() public {
        // Alice has TOTAL_SUPPLY, try to transfer more
        uint256 excessiveAmount = TOTAL_SUPPLY + 1;

        // The error comes from transferFrom, not burn
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            excessiveAmount
        );
    }

    function test_transferRemote_tip403Policy1AllowAll() public {
        // Policy 1 = allow all (default)
        assertEq(
            tip20Token.transferPolicyId(),
            1,
            "Default policy should be 1"
        );

        // Should succeed without explicit authorization
        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        assertTrue(
            messageId != bytes32(0),
            "Transfer should succeed with policy 1"
        );
    }

    function test_transferRemote_tip403Policy0RejectAll() public {
        // Set policy ID to 0 (reject all per TIP-403 spec)
        tip20Token.setTransferPolicyId(0);

        // Policy 0 means "reject all" - should revert
        vm.expectRevert("TIP403: transfers disabled");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }
}
