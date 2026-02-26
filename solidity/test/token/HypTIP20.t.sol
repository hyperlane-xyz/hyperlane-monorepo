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
import {HypTIP20} from "../../contracts/token/extensions/HypTIP20.sol";
import {ITIP20} from "../../contracts/token/interfaces/ITIP20.sol";
import {MockTIP20Factory} from "./MockTIP20Factory.sol";
import {MockTIP20} from "./MockTIP20.sol";
import {MockTIP403Registry} from "./MockTIP403Registry.sol";

contract HypTIP20Test is Test {
    using TypeCasts for address;
    using TokenMessage for bytes;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant DESTINATION = 12;
    uint256 internal constant TRANSFER_AMT = 100e6;
    string internal constant NAME = "SyntheticTIP20";
    string internal constant SYMBOL = "STIP";
    string internal constant CURRENCY = "USD";
    address internal constant ALICE = address(0x1);
    address internal constant BOB = address(0x2);

    MockTIP20Factory internal factory;
    MockTIP403Registry internal tip403Registry;
    HypTIP20 internal localToken;
    HypTIP20 internal remoteToken;
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

        // Deploy TIP-20 factory and etch it at the precompile address
        factory = new MockTIP20Factory();
        vm.etch(
            0x20Fc000000000000000000000000000000000000,
            address(factory).code
        );

        // Deploy TIP-403 registry
        tip403Registry = new MockTIP403Registry();

        // Deploy HypTIP20 on local chain
        localToken = new HypTIP20(
            NAME,
            SYMBOL,
            CURRENCY,
            ITIP20(address(0)), // quoteToken
            address(tip403Registry),
            bytes32(uint256(1)), // salt
            address(localMailbox)
        );

        // Deploy HypTIP20 on remote chain
        remoteToken = new HypTIP20(
            NAME,
            SYMBOL,
            CURRENCY,
            ITIP20(address(0)), // quoteToken
            address(tip403Registry),
            bytes32(uint256(2)), // different salt
            address(remoteMailbox)
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

        // Mint tokens to Alice (localToken has ISSUER_ROLE, so we prank as localToken)
        // Get the token address first, then prank for the mint call
        address tokenAddr = address(localToken.wrappedToken());
        vm.prank(address(localToken));
        ITIP20(tokenAddr).mint(ALICE, 1_000_000e6);

        // Approve localToken to spend Alice's tokens
        vm.prank(ALICE);
        MockTIP20(tokenAddr).approve(address(localToken), type(uint256).max);

        // Fund Alice with ETH for gas
        vm.deal(ALICE, 1 ether);
    }

    function test_constructor_createsTokenViaFactory() public {
        // Verify token was created
        address tokenAddr = address(localToken.wrappedToken());
        assertTrue(tokenAddr != address(0), "Token should be created");

        // Note: We can't verify factory.isTIP20() because the factory at the precompile
        // address is a fresh instance with empty storage after vm.etch

        // Verify token properties (cast to MockTIP20 to access ERC20 metadata)
        MockTIP20 token = MockTIP20(tokenAddr);
        assertEq(token.name(), NAME, "Token name should match");
        assertEq(token.symbol(), SYMBOL, "Token symbol should match");
        assertEq(token.decimals(), 6, "Token should have 6 decimals");
    }

    function test_constructor_grantsIssuerRole() public {
        // Verify ISSUER_ROLE was granted to the contract
        ITIP20 token = localToken.wrappedToken();
        bytes32 issuerRole = token.ISSUER_ROLE();

        // MockTIP20 uses owner pattern, not roles, so we check ownership
        // The factory transfers ownership to the admin (HypTIP20 contract)
        assertEq(
            MockTIP20(address(token)).owner(),
            address(localToken),
            "Contract should be token owner"
        );
    }

    function test_transferRemote_burnsTokens() public {
        uint256 aliceBalanceBefore = localToken.wrappedToken().balanceOf(ALICE);

        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );

        // Verify tokens were burned from Alice
        assertEq(
            localToken.wrappedToken().balanceOf(ALICE),
            aliceBalanceBefore - TRANSFER_AMT,
            "Alice balance should decrease"
        );

        // Verify contract does not hold tokens (they were burned)
        assertEq(
            localToken.wrappedToken().balanceOf(address(localToken)),
            0,
            "Contract should not hold tokens after burn"
        );

        assertTrue(messageId != bytes32(0), "Message ID should be non-zero");
    }

    function test_handle_mintsTokens() public {
        // Prepare message without memo
        // Note: Message amount is in Hyperlane format (18 decimals)
        // TRANSFER_AMT = 100e6 (TIP-20), scaled to 100e18 for Hyperlane
        uint256 hyperlaneAmount = TRANSFER_AMT * 1e12; // 100e18
        bytes memory message = TokenMessage.format(
            BOB.addressToBytes32(),
            hyperlaneAmount,
            "" // No metadata
        );

        uint256 bobBalanceBefore = remoteToken.wrappedToken().balanceOf(BOB);

        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemote(
            ORIGIN,
            BOB.addressToBytes32(),
            hyperlaneAmount
        );

        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            message
        );

        // Verify tokens were minted to Bob (in TIP-20 decimals)
        assertEq(
            remoteToken.wrappedToken().balanceOf(BOB),
            bobBalanceBefore + TRANSFER_AMT,
            "Bob should receive tokens"
        );
    }

    function test_transferRemoteWithMemo_preservesMemo() public {
        bytes32 memo = bytes32("INVOICE123");
        // Scaled amount is in Hyperlane format (18 decimals)
        uint256 scaledAmount = TRANSFER_AMT * 1e12; // 100e18

        vm.expectEmit(true, true, false, true);
        emit SentTransferRemoteWithMemo(
            DESTINATION,
            BOB.addressToBytes32(),
            scaledAmount,
            memo
        );

        vm.prank(ALICE);
        bytes32 messageId = localToken.transferRemoteWithMemo{
            value: REQUIRED_VALUE
        }(DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT, memo);

        assertTrue(messageId != bytes32(0), "Message ID should be non-zero");
    }

    function test_handle_withMemo_callsMintWithMemo() public {
        bytes32 memo = bytes32("PAYMENT456");

        // Prepare message with memo in metadata
        // Note: Message amount is in Hyperlane format (18 decimals)
        uint256 hyperlaneAmount = TRANSFER_AMT * 1e12; // 100e18
        bytes memory message = TokenMessage.format(
            BOB.addressToBytes32(),
            hyperlaneAmount,
            abi.encodePacked(memo)
        );

        uint256 bobBalanceBefore = remoteToken.wrappedToken().balanceOf(BOB);

        // Expect MintWithMemo event from the token (with TIP-20 amount)
        vm.expectEmit(true, false, true, true);
        emit MintWithMemo(BOB, TRANSFER_AMT, memo);

        // Expect ReceivedTransferRemoteWithMemo event from the router (with TIP-20 amount)
        vm.expectEmit(true, true, false, true);
        emit ReceivedTransferRemoteWithMemo(
            ORIGIN,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            memo
        );

        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            message
        );

        // Verify tokens were minted to Bob (in TIP-20 decimals)
        assertEq(
            remoteToken.wrappedToken().balanceOf(BOB),
            bobBalanceBefore + TRANSFER_AMT,
            "Bob should receive tokens"
        );
    }

    function test_tip403_policy0_reverts() public {
        // Set policy ID to 0 (reject all per TIP-403 spec)
        // Need to prank as the token owner (which is localToken contract)
        MockTIP20 token = MockTIP20(address(localToken.wrappedToken()));
        vm.prank(address(localToken));
        token.setTransferPolicyId(0);

        // Policy 0 means "reject all" - should revert
        vm.expectRevert("TIP403: transfers disabled");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_tip403_policy1_allows() public {
        // Policy 1 = allow all (default)
        assertEq(
            MockTIP20(address(localToken.wrappedToken())).transferPolicyId(),
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

    function test_tip403_unauthorized_reverts() public {
        // Set policy ID to 2 (custom policy requiring authorization)
        MockTIP20 token = MockTIP20(address(localToken.wrappedToken()));
        vm.prank(address(localToken));
        token.setTransferPolicyId(2);

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

    function test_tip403_authorized_succeeds() public {
        // Set policy ID to 2 (custom policy requiring authorization)
        MockTIP20 token = MockTIP20(address(localToken.wrappedToken()));
        vm.prank(address(localToken));
        token.setTransferPolicyId(2);

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

    function test_tip403_disabled_allowsAll() public {
        // Deploy a new HypTIP20 without TIP-403 registry
        HypTIP20 tokenNoRegistry = new HypTIP20(
            NAME,
            SYMBOL,
            CURRENCY,
            ITIP20(address(0)), // quoteToken
            address(0), // No registry
            bytes32(uint256(3)), // different salt
            address(localMailbox)
        );

        // Enroll remote router
        tokenNoRegistry.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );

        // Get wrapped token reference first
        MockTIP20 wrappedTokenNoReg = MockTIP20(
            address(tokenNoRegistry.wrappedToken())
        );

        // Mint tokens to Alice (tokenNoRegistry has ISSUER_ROLE)
        vm.prank(address(tokenNoRegistry));
        wrappedTokenNoReg.mint(ALICE, 1_000_000e6);

        // Approve tokenNoRegistry to spend Alice's tokens
        vm.prank(ALICE);
        wrappedTokenNoReg.approve(address(tokenNoRegistry), type(uint256).max);

        // Set policy ID to 2 (would require authorization if registry was enabled)
        vm.prank(address(tokenNoRegistry));
        wrappedTokenNoReg.setTransferPolicyId(2);

        // Alice is NOT authorized, but registry is disabled
        // Should succeed because TIP-403 is disabled
        vm.prank(ALICE);
        bytes32 messageId = tokenNoRegistry.transferRemote{
            value: REQUIRED_VALUE
        }(DESTINATION, BOB.addressToBytes32(), TRANSFER_AMT);

        assertTrue(
            messageId != bytes32(0),
            "Transfer should succeed when registry is disabled"
        );
    }

    function test_transferRemote_insufficientBalance() public {
        // Alice has 1M tokens, try to transfer more
        uint256 excessiveAmount = 2_000_000e6;

        // The error comes from transferFrom, which checks balance
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            excessiveAmount
        );
    }

    function test_transferRemote_pausedToken() public {
        // Pause the token (need to prank as owner)
        MockTIP20 token = MockTIP20(address(localToken.wrappedToken()));
        vm.prank(address(localToken));
        token.pause();

        // Transfer should revert because burn() will fail on paused token
        vm.expectRevert("MockTIP20: token is paused");
        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT
        );
    }

    function test_token_returnsWrappedToken() public {
        assertEq(
            localToken.token(),
            address(localToken.wrappedToken()),
            "token() should return wrappedToken address"
        );
    }

    function test_scale_is1e12() public {
        // TIP-20 uses 6 decimals, Hyperlane uses 18 decimals
        // Scale should be 1e12 to convert between them
        // We can verify this by checking the outbound/inbound scaling

        // Send 100e6 tokens (TIP-20 decimals)
        uint256 tip20Amount = 100e6;

        // The message should contain 100e18 (Hyperlane decimals)
        uint256 expectedHyperlaneAmount = 100e18;

        vm.prank(ALICE);
        localToken.transferRemote{value: REQUIRED_VALUE}(
            DESTINATION,
            BOB.addressToBytes32(),
            tip20Amount
        );

        // Process the message on remote chain
        bytes memory message = TokenMessage.format(
            BOB.addressToBytes32(),
            expectedHyperlaneAmount,
            ""
        );

        vm.prank(address(remoteMailbox));
        remoteToken.handle(
            ORIGIN,
            address(localToken).addressToBytes32(),
            message
        );

        // Bob should receive 100e6 tokens (TIP-20 decimals)
        assertEq(
            remoteToken.wrappedToken().balanceOf(BOB),
            tip20Amount,
            "Bob should receive correct amount in TIP-20 decimals"
        );
    }
}
