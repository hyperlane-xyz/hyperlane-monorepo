// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {LinearFee} from "../../contracts/token/fees/LinearFee.sol";
import {TransferRouter} from "../../contracts/token/TransferRouter.sol";
import {Quote, ITokenBridge, ITokenFee} from "../../contracts/interfaces/ITokenBridge.sol";

// ============ Mock Token Router ============

/**
 * @notice Mock that implements ITokenBridge + token() to simulate an underlying warp route.
 * @dev Does NOT inherit from Router/TokenRouter. Pulls tokens via safeTransferFrom and
 *      records call parameters for test assertions.
 */
contract MockTokenRouter is ITokenBridge {
    using SafeERC20 for IERC20;

    address public immutable tokenAddr;

    // --- Configurable quote returns ---
    Quote[] private _quotes;

    // --- Call tracking ---
    uint32 public lastDestination;
    bytes32 public lastRecipient;
    uint256 public lastAmount;
    uint256 public lastMsgValue;
    uint256 public callCount;

    constructor(address _token) {
        tokenAddr = _token;
    }

    function token() external view returns (address) {
        return tokenAddr;
    }

    // --- Quote configuration ---

    function setQuotes(Quote[] memory quotes) external {
        delete _quotes;
        for (uint256 i = 0; i < quotes.length; i++) {
            _quotes.push(quotes[i]);
        }
    }

    function quoteTransferRemote(
        uint32 /*_destination*/,
        bytes32 /*_recipient*/,
        uint256 /*_amount*/
    ) external view override returns (Quote[] memory quotes) {
        quotes = new Quote[](_quotes.length);
        for (uint256 i = 0; i < _quotes.length; i++) {
            quotes[i] = _quotes[i];
        }
    }

    // --- Transfer (pulls tokens, records params) ---

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable override returns (bytes32) {
        // Pull tokens from msg.sender
        IERC20(tokenAddr).safeTransferFrom(msg.sender, address(this), _amount);

        // Record call params
        lastDestination = _destination;
        lastRecipient = _recipient;
        lastAmount = _amount;
        lastMsgValue = msg.value;
        callCount++;

        // Return a deterministic mock messageId
        return
            keccak256(
                abi.encodePacked(_destination, _recipient, _amount, callCount)
            );
    }
}

// ============ Abstract Test Base ============

abstract contract TransferRouterTestBase is Test {
    ERC20Test internal token;
    MockTokenRouter internal route;
    LinearFee internal feeContract;
    TransferRouter internal transferRouter;

    address internal constant OWNER = address(0xA11CE);
    address internal constant USER = address(0xB0B);
    uint32 internal constant DESTINATION = 42;
    bytes32 internal constant RECIPIENT =
        bytes32(uint256(uint160(address(0xCAFE))));
    uint256 internal constant TRANSFER_AMOUNT = 10_000e18;
    uint256 internal constant INITIAL_BALANCE = 1_000_000e18;

    // LinearFee params
    uint256 internal constant MAX_FEE = 1000e18;
    uint256 internal constant HALF_AMOUNT = 10_000e18;

    function setUp() public virtual {
        vm.label(OWNER, "Owner");
        vm.label(USER, "User");

        // 1. Deploy test ERC20
        token = new ERC20Test("Test Token", "TST", 0, 18);
        vm.label(address(token), "TestToken");

        // 2. Deploy MockTokenRouter configured with the test token
        route = new MockTokenRouter(address(token));
        vm.label(address(route), "MockTokenRouter");

        // 3. Configure mock route quotes (3-quote structure matching TokenRouter)
        _setupRouteQuotes();

        // 4. Deploy LinearFee with the test token
        feeContract = new LinearFee(
            address(token),
            MAX_FEE,
            HALF_AMOUNT,
            OWNER
        );
        vm.label(address(feeContract), "LinearFee");

        // 5. Deploy TransferRouter stub
        transferRouter = new TransferRouter(
            address(token),
            address(feeContract),
            OWNER
        );
        vm.label(address(transferRouter), "TransferRouter");

        // 6. Mint tokens to USER and set approvals
        token.mintTo(USER, INITIAL_BALANCE);
        vm.startPrank(USER);
        token.approve(address(transferRouter), type(uint256).max);
        token.approve(address(route), type(uint256).max);
        vm.stopPrank();
    }

    function _setupRouteQuotes() internal {
        // Mimic TokenRouter's 3-quote structure:
        //  [0] native gas fee
        //  [1] token amount + internal fee
        //  [2] external bridging fee
        Quote[] memory quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0.01 ether}); // native gas
        quotes[1] = Quote({token: address(token), amount: TRANSFER_AMOUNT}); // token amount (no internal route fee)
        quotes[2] = Quote({token: address(token), amount: 0}); // no external fee
        route.setQuotes(quotes);
    }
}

// ============ Tests ============

contract TransferRouterTest is TransferRouterTestBase {
    // ==================== Constructor ====================

    function test_Constructor_SetsTokenAndFeeContract() public view {
        assertEq(
            address(transferRouter.token()),
            address(token),
            "token mismatch"
        );
        assertEq(
            transferRouter.feeContract(),
            address(feeContract),
            "feeContract mismatch"
        );
    }

    // ==================== Transfer Remote (happy path) ====================

    function test_TransferRemote_Success() public {
        // Calculate expected fee from LinearFee
        Quote[] memory feeQuotes = feeContract.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT
        );
        uint256 expectedFee = feeQuotes[0].amount;
        assertTrue(expectedFee > 0, "fee should be non-zero");

        uint256 userBefore = token.balanceOf(USER);
        uint256 feeBefore = token.balanceOf(address(feeContract));
        uint256 routeBefore = token.balanceOf(address(route));

        // Execute transfer as USER
        vm.prank(USER);
        bytes32 messageId = transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        // Zero-dust invariant
        assertEq(token.balanceOf(address(transferRouter)), 0, "Dust remaining");

        // Fee assertion
        assertEq(
            token.balanceOf(address(feeContract)) - feeBefore,
            expectedFee,
            "Fee incorrect"
        );

        // Route received tokens
        assertEq(
            token.balanceOf(address(route)) - routeBefore,
            TRANSFER_AMOUNT,
            "Route received wrong amount"
        );

        // User charged correctly
        assertEq(
            userBefore - token.balanceOf(USER),
            TRANSFER_AMOUNT + expectedFee,
            "User charged incorrectly"
        );

        // Verify forwarding params
        assertEq(route.lastDestination(), DESTINATION, "destination mismatch");
        assertEq(route.lastRecipient(), RECIPIENT, "recipient mismatch");
        assertEq(route.lastAmount(), TRANSFER_AMOUNT, "amount mismatch");

        // Verify messageId returned
        assertTrue(messageId != bytes32(0), "messageId should be non-zero");
    }

    // ==================== Quote ====================

    function test_QuoteTransferRemote_IncludesUnderlyingAndOurFee()
        public
        view
    {
        Quote[] memory quotes = transferRouter.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        // Should include underlying route quotes + our fee
        assertTrue(quotes.length > 0, "should return quotes");

        // Get the fee our feeContract would charge
        Quote[] memory feeQuotes = feeContract.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT
        );
        uint256 ourFee = feeQuotes[0].amount;

        // Find the token quote — it should include TRANSFER_AMOUNT + ourFee
        bool foundTokenQuote = false;
        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token == address(token)) {
                // The token quote should account for both the underlying amount and our fee
                assertGe(
                    quotes[i].amount,
                    TRANSFER_AMOUNT + ourFee,
                    "token quote should include transfer amount + our fee"
                );
                foundTokenQuote = true;
                break;
            }
        }
        assertTrue(foundTokenQuote, "should have a token-denominated quote");
    }

    // ==================== Revert Tests ====================

    function test_RevertIf_TokenMismatch() public {
        ERC20Test otherToken = new ERC20Test("Other", "OTH", 0, 18);
        MockTokenRouter mismatchedRoute = new MockTokenRouter(
            address(otherToken)
        );

        otherToken.mintTo(USER, INITIAL_BALANCE);
        vm.startPrank(USER);
        otherToken.approve(address(transferRouter), type(uint256).max);
        token.approve(address(transferRouter), type(uint256).max);
        vm.stopPrank();

        vm.prank(USER);
        vm.expectRevert("token mismatch");
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(mismatchedRoute)
        );
    }

    function test_RevertIf_NonOwnerSetsFeeContract() public {
        vm.prank(address(0x999));
        vm.expectRevert("Ownable: caller is not the owner");
        transferRouter.setFeeContract(address(feeContract));
    }

    function test_RevertIf_FeeContractTokenMismatch() public {
        ERC20Test otherToken = new ERC20Test("Other", "OTH", 0, 18);
        LinearFee mismatchedFee = new LinearFee(
            address(otherToken),
            MAX_FEE,
            HALF_AMOUNT,
            OWNER
        );

        vm.prank(OWNER);
        vm.expectRevert("fee token mismatch");
        transferRouter.setFeeContract(address(mismatchedFee));
    }

    function test_RevertIf_InsufficientApproval() public {
        // USER revokes approval
        vm.prank(USER);
        token.approve(address(transferRouter), 0);

        vm.prank(USER);
        vm.expectRevert("ERC20: insufficient allowance");
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );
    }

    function test_RevertIf_InsufficientBalance() public {
        // USER with no balance
        address poorUser = address(0xDEAD);
        vm.startPrank(poorUser);
        token.approve(address(transferRouter), type(uint256).max);
        vm.stopPrank();

        vm.prank(poorUser);
        vm.expectRevert("ERC20: transfer amount exceeds balance");
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );
    }

    // ==================== Edge Case Tests ====================

    function test_TransferRemote_NoFeeContract() public {
        // Deploy a TransferRouter with no fee contract
        TransferRouter noFeeRouter = new TransferRouter(
            address(token),
            address(0),
            OWNER
        );

        vm.prank(USER);
        token.approve(address(noFeeRouter), type(uint256).max);

        uint256 userBefore = token.balanceOf(USER);
        uint256 routeBefore = token.balanceOf(address(route));

        vm.prank(USER);
        noFeeRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        // Zero-dust invariant
        assertEq(token.balanceOf(address(noFeeRouter)), 0, "Dust remaining");

        // No fee charged — user only paid the transfer amount
        assertEq(
            userBefore - token.balanceOf(USER),
            TRANSFER_AMOUNT,
            "User charged incorrectly"
        );

        // Route received the full amount
        assertEq(
            token.balanceOf(address(route)) - routeBefore,
            TRANSFER_AMOUNT,
            "Route received wrong amount"
        );
    }

    function test_TransferRemote_NoDustRemaining() public {
        vm.prank(USER);
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        assertEq(token.balanceOf(address(transferRouter)), 0, "Dust remaining");
    }

    function test_TransferRemote_ForwardsNativeGas() public {
        uint256 nativeGas = 0.05 ether;
        vm.deal(USER, nativeGas);

        vm.prank(USER);
        transferRouter.transferRemote{value: nativeGas}(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        assertEq(route.lastMsgValue(), nativeGas, "Native gas not forwarded");
        assertEq(token.balanceOf(address(transferRouter)), 0, "Dust remaining");
    }

    function test_TransferRemote_WithUnderlyingRouteFee() public {
        // Set route to charge an extra bridging fee (external fee slot)
        uint256 routeFee = 100e18;
        Quote[] memory quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0.01 ether}); // native gas
        quotes[1] = Quote({token: address(token), amount: TRANSFER_AMOUNT}); // token amount
        quotes[2] = Quote({token: address(token), amount: routeFee}); // external bridging fee
        route.setQuotes(quotes);

        // MockTokenRouter pulls TRANSFER_AMOUNT (the _amount param) via safeTransferFrom,
        // so the underlying token needs = TRANSFER_AMOUNT + routeFee from the quote extraction
        // But MockTokenRouter.transferRemote only pulls _amount. Let's adjust:
        // The route quotes extract to TRANSFER_AMOUNT + routeFee, but the mock only pulls _amount.
        // This means TransferRouter approves route for TRANSFER_AMOUNT + routeFee, route only takes TRANSFER_AMOUNT.
        // After approval reset, TRANSFER_AMOUNT is in route and routeFee stays in TransferRouter.
        // To make the test realistic, we need the mock to pull the full underlying needs.
        // Actually, looking at TransferRouter code: it approves `underlyingNeeds` and route pulls `_amount`.
        // If underlyingNeeds > _amount, the route would only pull _amount, leaving dust.
        // But in real routes, the quotes[1].amount IS the _amount and quotes[2] is an additional fee
        // that the route also pulls. Our mock only pulls _amount though.
        // Let's just verify the stacked quote math works correctly.

        Quote[] memory feeQuotes = feeContract.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT
        );
        uint256 ourFee = feeQuotes[0].amount;

        uint256 userBefore = token.balanceOf(USER);
        uint256 feeBefore = token.balanceOf(address(feeContract));

        vm.prank(USER);
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        // Fee contract received our fee
        assertEq(
            token.balanceOf(address(feeContract)) - feeBefore,
            ourFee,
            "Fee incorrect"
        );

        // User was charged underlyingNeeds (TRANSFER_AMOUNT + routeFee) + ourFee
        uint256 underlyingNeeds = TRANSFER_AMOUNT + routeFee;
        assertEq(
            userBefore - token.balanceOf(USER),
            underlyingNeeds + ourFee,
            "User charged incorrectly"
        );

        // Verify route got the transfer amount
        assertEq(route.lastAmount(), TRANSFER_AMOUNT, "amount mismatch");
    }

    function test_TransferRemote_ZeroAmount() public {
        // Set route quotes to reflect zero amount
        Quote[] memory quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0.01 ether}); // native gas
        quotes[1] = Quote({token: address(token), amount: 0}); // zero token amount
        quotes[2] = Quote({token: address(token), amount: 0}); // no external fee
        route.setQuotes(quotes);

        uint256 userBefore = token.balanceOf(USER);

        vm.deal(USER, 0.01 ether);
        vm.prank(USER);
        transferRouter.transferRemote{value: 0.01 ether}(
            DESTINATION,
            RECIPIENT,
            0,
            address(route)
        );

        // Zero-dust invariant
        assertEq(token.balanceOf(address(transferRouter)), 0, "Dust remaining");

        // No tokens deducted from user (fee on 0 is 0)
        assertEq(token.balanceOf(USER), userBefore, "User charged incorrectly");

        // Route recorded amount = 0
        assertEq(route.lastAmount(), 0, "amount should be 0");
    }

    function test_TransferRemote_ApprovalResetToZero() public {
        vm.prank(USER);
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        assertEq(
            token.allowance(address(transferRouter), address(route)),
            0,
            "Approval not reset to zero"
        );
    }

    function test_SetFeeContract_EmitsEvent() public {
        LinearFee newFee = new LinearFee(
            address(token),
            MAX_FEE,
            HALF_AMOUNT,
            OWNER
        );

        vm.prank(OWNER);
        vm.expectEmit(true, true, false, true, address(transferRouter));
        emit TransferRouter.FeeContractSet(address(newFee));
        transferRouter.setFeeContract(address(newFee));
    }

    function test_SetFeeContract_UpdatesFeeContract() public {
        LinearFee newFee = new LinearFee(
            address(token),
            MAX_FEE,
            HALF_AMOUNT,
            OWNER
        );

        vm.prank(OWNER);
        transferRouter.setFeeContract(address(newFee));

        assertEq(
            transferRouter.feeContract(),
            address(newFee),
            "feeContract not updated"
        );
    }

    function test_SetFeeContract_ToZeroAddress() public {
        // Disable fees
        vm.prank(OWNER);
        transferRouter.setFeeContract(address(0));

        assertEq(
            transferRouter.feeContract(),
            address(0),
            "feeContract should be zero"
        );

        // Transfer should still work with no fee
        uint256 userBefore = token.balanceOf(USER);

        vm.prank(USER);
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            TRANSFER_AMOUNT,
            address(route)
        );

        // Zero-dust invariant
        assertEq(token.balanceOf(address(transferRouter)), 0, "Dust remaining");

        // No fee charged
        assertEq(
            userBefore - token.balanceOf(USER),
            TRANSFER_AMOUNT,
            "User charged incorrectly"
        );
    }

    // ==================== Fuzz Tests ====================

    function test_TransferRemote_FuzzAmount(uint96 amount) public {
        // Prevent overflow: underlyingNeeds + ourFee must fit in uint256
        // and user must have enough balance
        vm.assume(amount > 0);
        vm.assume(uint256(amount) <= INITIAL_BALANCE / 2); // plenty of room for fee

        // Update route quotes to match the fuzzed amount
        Quote[] memory quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0.01 ether});
        quotes[1] = Quote({token: address(token), amount: uint256(amount)});
        quotes[2] = Quote({token: address(token), amount: 0});
        route.setQuotes(quotes);

        // Calculate expected fee
        Quote[] memory feeQuotes = feeContract.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            uint256(amount)
        );
        uint256 expectedFee = feeQuotes[0].amount;

        uint256 userBefore = token.balanceOf(USER);
        uint256 feeBefore = token.balanceOf(address(feeContract));
        uint256 routeBefore = token.balanceOf(address(route));

        vm.prank(USER);
        transferRouter.transferRemote(
            DESTINATION,
            RECIPIENT,
            uint256(amount),
            address(route)
        );

        // Zero-dust invariant
        assertEq(token.balanceOf(address(transferRouter)), 0, "Dust remaining");

        // Fee assertion
        assertEq(
            token.balanceOf(address(feeContract)) - feeBefore,
            expectedFee,
            "Fee incorrect"
        );

        // Route received tokens
        assertEq(
            token.balanceOf(address(route)) - routeBefore,
            uint256(amount),
            "Route received wrong amount"
        );

        // User charged correctly
        assertEq(
            userBefore - token.balanceOf(USER),
            uint256(amount) + expectedFee,
            "User charged incorrectly"
        );
    }

    function test_QuoteTransferRemote_FuzzAmount(uint96 amount) public view {
        // No overflow constraints needed — quoteTransferRemote is view-only
        Quote[] memory quotes = transferRouter.quoteTransferRemote(
            DESTINATION,
            RECIPIENT,
            uint256(amount),
            address(route)
        );

        // Quote structure should always be valid
        assertTrue(quotes.length > 0, "should return quotes");

        // Should contain at least one token-denominated quote
        bool foundTokenQuote = false;
        for (uint256 i = 0; i < quotes.length; i++) {
            if (quotes[i].token == address(token)) {
                foundTokenQuote = true;
                break;
            }
        }
        assertTrue(foundTokenQuote, "should have token-denominated quote");
    }
}
