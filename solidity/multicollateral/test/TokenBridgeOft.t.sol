// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.22;

import "forge-std/Test.sol";

import {TokenBridgeOft} from "../contracts/TokenBridgeOft.sol";
import {IOFT, SendParam, MessagingFee, MessagingReceipt, OFTReceipt, OFTLimit, OFTFeeDetail} from "../contracts/interfaces/layerzero/IOFT.sol";
import {Quote} from "@hyperlane-xyz/core/interfaces/ITokenBridge.sol";
import {MockMailbox} from "@hyperlane-xyz/core/mock/MockMailbox.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Test} from "@hyperlane-xyz/core/test/ERC20Test.sol";

/**
 * @title MockOFT
 * @notice Mock OFT for deterministic unit testing (no fork required).
 *         Simulates a Native OFT (burn/mint) pattern.
 */
contract MockOFT is IOFT {
    address public tokenAddress;
    bool public approvalRequiredValue;
    uint256 public nativeFeeToReturn;
    uint256 public feeBps; // Linear fee in basis points (e.g. 100 = 1%)
    bytes32 public guidToReturn;
    bool public shouldRevertOnSend;
    uint8 public _sharedDecimals;
    uint8 public _localDecimals;

    constructor(address _token, bool _approvalRequired) {
        tokenAddress = _token;
        approvalRequiredValue = _approvalRequired;
        nativeFeeToReturn = 0.001 ether;
        guidToReturn = keccak256("mock-guid");
        _sharedDecimals = 6;
        _localDecimals = 6;
    }

    function setNativeFee(uint256 _fee) external {
        nativeFeeToReturn = _fee;
    }

    function setFeeBps(uint256 _feeBps) external {
        feeBps = _feeBps;
    }

    function setGuid(bytes32 _guid) external {
        guidToReturn = _guid;
    }

    function setShouldRevertOnSend(bool _revert) external {
        shouldRevertOnSend = _revert;
    }

    function setDecimals(uint8 local, uint8 shared) external {
        _localDecimals = local;
        _sharedDecimals = shared;
    }

    function _conversionRate() internal view returns (uint256) {
        return 10 ** (_localDecimals - _sharedDecimals);
    }

    /// @dev Mirrors OFT._removeDust: truncate sub-sharedDecimals precision
    function _removeDust(uint256 _amount) internal view returns (uint256) {
        uint256 rate = _conversionRate();
        return (_amount / rate) * rate;
    }

    function _applyFee(
        uint256 _amount
    ) internal view returns (uint256 sent, uint256 received) {
        sent = _removeDust(_amount);
        uint256 fee = feeBps > 0 ? (sent * feeBps) / 10000 : 0;
        received = sent - fee;
    }

    // ---- IOFT ----

    function oftVersion() external pure returns (bytes4, uint64) {
        return (bytes4(0x02e49c2c), 1);
    }

    function token() external view returns (address) {
        return tokenAddress;
    }

    function approvalRequired() external view returns (bool) {
        return approvalRequiredValue;
    }

    function sharedDecimals() external view returns (uint8) {
        return _sharedDecimals;
    }

    function quoteSend(
        SendParam calldata,
        bool
    ) external view returns (MessagingFee memory) {
        return MessagingFee({nativeFee: nativeFeeToReturn, lzTokenFee: 0});
    }

    function quoteOFT(
        SendParam calldata _sendParam
    )
        external
        view
        returns (OFTLimit memory, OFTFeeDetail[] memory, OFTReceipt memory)
    {
        (uint256 sent, uint256 received) = _applyFee(_sendParam.amountLD);
        return (
            OFTLimit({minAmountLD: 0, maxAmountLD: type(uint256).max}),
            new OFTFeeDetail[](0),
            OFTReceipt({amountSentLD: sent, amountReceivedLD: received})
        );
    }

    function send(
        SendParam calldata _sendParam,
        MessagingFee calldata,
        address
    ) external payable returns (MessagingReceipt memory, OFTReceipt memory) {
        require(!shouldRevertOnSend, "MockOFT: send reverted");

        // Simulate burn/mint: pull tokens from sender if approvalRequired
        if (approvalRequiredValue) {
            IERC20(tokenAddress).transferFrom(
                msg.sender,
                address(this),
                _sendParam.amountLD
            );
        }

        (uint256 sent, uint256 received) = _applyFee(_sendParam.amountLD);

        // Simulate slippage check like real OFT
        require(
            received >= _sendParam.minAmountLD,
            "MockOFT: SlippageExceeded"
        );

        return (
            MessagingReceipt({
                guid: guidToReturn,
                nonce: 1,
                fee: MessagingFee({nativeFee: msg.value, lzTokenFee: 0})
            }),
            OFTReceipt({amountSentLD: sent, amountReceivedLD: received})
        );
    }
}

/**
 * @title MockOFTAdapter
 * @notice Same as MockOFT but with approvalRequired=true (lock/unlock pattern).
 */
contract MockOFTAdapter is MockOFT {
    constructor(address _token) MockOFT(_token, true) {}
}

/**
 * @title MockFeeRecipient
 * @notice Mock ITokenFee that charges a fixed fee in the warp token.
 */
contract MockFeeRecipient {
    address public feeToken;
    uint256 public feeAmount;

    constructor(address _token, uint256 _fee) {
        feeToken = _token;
        feeAmount = _fee;
    }

    function quoteTransferRemote(
        uint32,
        bytes32,
        uint256
    ) external view returns (Quote[] memory quotes) {
        quotes = new Quote[](1);
        quotes[0] = Quote({token: feeToken, amount: feeAmount});
    }
}

// ============================================================
//  Unit Tests
// ============================================================

contract TokenBridgeOftUnitTest is Test {
    uint32 constant DOMAIN_ETH = 1;
    uint32 constant DOMAIN_ARB = 42161;
    uint32 constant LZ_EID_ETH = 30101;
    uint32 constant LZ_EID_ARB = 30110;

    ERC20Test internal token;
    MockOFT internal mockOft;
    MockMailbox internal mailbox;
    TokenBridgeOft internal bridge;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        token = new ERC20Test("MockUSDT", "mUSDT", 0, 6);
        mockOft = new MockOFT(address(token), false);
        mailbox = new MockMailbox(1);
        bridge = new TokenBridgeOft(address(mockOft), address(mailbox));
        bridge.initialize(address(0), address(0), owner);

        vm.prank(owner);
        bridge.addDomain(DOMAIN_ETH, LZ_EID_ETH);
        vm.prank(owner);
        bridge.addDomain(DOMAIN_ARB, LZ_EID_ARB);

        // Fund caller
        token.mintTo(caller, 1_000e6);
        vm.deal(caller, 10 ether);
    }

    // ---- Construction ----

    function test_constructor_setsImmutables() public view {
        assertEq(address(bridge.oft()), address(mockOft));
        assertEq(bridge.token(), address(token));
    }

    function test_constructor_revertsOnZeroOft() public {
        vm.expectRevert("TokenBridgeOft: zero OFT address");
        new TokenBridgeOft(address(0), address(mailbox));
    }

    // ---- Domain Mapping ----

    function test_addDomain() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit TokenBridgeOft.DomainAdded(99, 12345);
        bridge.addDomain(99, 12345);

        assertEq(bridge.hyperlaneDomainToLzEid(99), 12345);
    }

    function test_addDomain_revertsNonOwner() public {
        vm.prank(caller);
        vm.expectRevert("Ownable: caller is not the owner");
        bridge.addDomain(99, 12345);
    }

    function test_addDomain_revertsOnZeroEid() public {
        vm.prank(owner);
        vm.expectRevert("TokenBridgeOft: zero LZ EID");
        bridge.addDomain(99, 0);
    }

    function test_removeDomain() public {
        vm.prank(owner);
        bridge.removeDomain(DOMAIN_ETH);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeOft.LzEidNotConfigured.selector,
                DOMAIN_ETH
            )
        );
        bridge.hyperlaneDomainToLzEid(DOMAIN_ETH);
    }

    function test_removeDomain_revertsOnNonExistent() public {
        vm.prank(owner);
        vm.expectRevert("TokenBridgeOft: domain not configured");
        bridge.removeDomain(999);
    }

    function test_getDomainMappings() public view {
        (uint32[] memory domains, uint32[] memory lzEids) = bridge
            .getDomainMappings();
        assertEq(domains.length, 2);
        assertEq(lzEids.length, 2);
    }

    // ---- Quote ----

    function test_quoteTransferRemote_returnsThreeQuotes() public view {
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            100e6
        );

        // TokenRouter returns 3: native gas, token fee, external fee
        assertEq(quotes.length, 3, "3 quotes");
        assertEq(quotes[0].token, address(0), "native fee token");
        assertEq(quotes[0].amount, 0.001 ether, "native fee from mock");
    }

    function test_quoteTransferRemote_revertsUnconfiguredDomain() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeOft.LzEidNotConfigured.selector,
                uint32(999)
            )
        );
        bridge.quoteTransferRemote(999, recipient, 100e6);
    }

    function test_quoteTransferRemote_varyingFees() public {
        mockOft.setNativeFee(0.05 ether);
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            100e6
        );
        assertEq(quotes[0].amount, 0.05 ether);
    }

    // ---- Transfer ----

    function test_transferRemote() public {
        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        bytes32 messageId = bridge.transferRemote{value: 0.001 ether}(
            DOMAIN_ETH,
            recipient,
            100e6
        );
        vm.stopPrank();

        assertEq(messageId, mockOft.guidToReturn());
        // Tokens pulled from caller
        assertEq(token.balanceOf(caller), 900e6);
    }

    function test_transferRemote_insufficientBalance() public {
        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        vm.expectRevert("ERC20: transfer amount exceeds balance");
        bridge.transferRemote{value: 0.001 ether}(
            DOMAIN_ETH,
            recipient,
            2_000e6 // more than caller has
        );
        vm.stopPrank();
    }

    function test_transferRemote_insufficientAllowance() public {
        vm.startPrank(caller);
        token.approve(address(bridge), 50e6);

        vm.expectRevert("ERC20: insufficient allowance");
        bridge.transferRemote{value: 0.001 ether}(DOMAIN_ETH, recipient, 100e6);
        vm.stopPrank();
    }

    function test_transferRemote_unconfiguredDomain() public {
        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                TokenBridgeOft.LzEidNotConfigured.selector,
                uint32(999)
            )
        );
        bridge.transferRemote{value: 0.001 ether}(999, recipient, 100e6);
        vm.stopPrank();
    }

    // ---- Options / Admin ----

    function test_setExtraOptions() public {
        bytes memory options = hex"deadbeef";
        vm.prank(owner);
        bridge.setExtraOptions(options);
        assertEq(bridge.extraOptions(), options);
    }

    function test_transferRemote_refundsExcessValue() public {
        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        uint256 callerBalBefore = caller.balance;
        // Send 1 ether but mock only charges 0.001 ether
        bridge.transferRemote{value: 1 ether}(DOMAIN_ETH, recipient, 100e6);
        vm.stopPrank();

        // Excess should be refunded to caller
        uint256 callerBalAfter = caller.balance;
        assertEq(
            callerBalAfter,
            callerBalBefore - 0.001 ether,
            "excess ETH should be refunded"
        );
        assertEq(address(bridge).balance, 0, "bridge should have no ETH");
    }

    // ---- Handle (inbound) ----

    function test_handle_revertsFromMailbox() public {
        // Enroll a router so it passes the router check
        bytes32 router = bytes32(uint256(uint160(makeAddr("router"))));
        vm.prank(owner);
        bridge.enrollRemoteRouter(DOMAIN_ETH, router);

        vm.prank(address(mailbox));
        vm.expectRevert("TokenBridgeOft: no inbound handling");
        bridge.handle(DOMAIN_ETH, router, "");
    }

    function test_handle_revertsFromNonMailbox() public {
        vm.prank(caller);
        vm.expectRevert("MailboxClient: sender not mailbox");
        bridge.handle(1, bytes32(0), "");
    }

    // ---- Receive ----

    function test_receiveEth() public {
        vm.deal(address(this), 1 ether);
        (bool ok, ) = address(bridge).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(address(bridge).balance, 0.5 ether);
    }

    // ---- Fee Recipient ----

    function test_transferRemote_feeRecipientReceivesFee() public {
        uint256 protocolFee = 5e6; // 5 USDT fee
        MockFeeRecipient feeRecip = new MockFeeRecipient(
            address(token),
            protocolFee
        );

        vm.prank(owner);
        bridge.setFeeRecipient(address(feeRecip));

        uint256 amount = 100e6;
        uint256 nativeFee = mockOft.nativeFeeToReturn();

        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);
        bridge.transferRemote{value: nativeFee}(DOMAIN_ETH, recipient, amount);
        vm.stopPrank();

        // Fee recipient should have received the protocol fee
        assertEq(token.balanceOf(address(feeRecip)), protocolFee);
        // Bridge holds only the amount destined for OFT (mock doesn't burn).
        // Crucially, the fee is NOT stuck in the bridge — it went to the recipient.
        assertEq(token.balanceOf(address(bridge)), amount);
    }

    function test_transferRemote_feeRecipientPlusOftFee() public {
        // Configure both a protocol fee recipient AND an OFT fee
        uint256 protocolFee = 2e6;
        MockFeeRecipient feeRecip = new MockFeeRecipient(
            address(token),
            protocolFee
        );
        vm.prank(owner);
        bridge.setFeeRecipient(address(feeRecip));

        mockOft.setFeeBps(100); // 1% OFT fee

        uint256 amount = 100e6;
        uint256 nativeFee = mockOft.nativeFeeToReturn();

        uint256 callerBalBefore = token.balanceOf(caller);

        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);
        bridge.transferRemote{value: nativeFee}(DOMAIN_ETH, recipient, amount);
        vm.stopPrank();

        // Fee recipient gets protocol fee
        assertEq(token.balanceOf(address(feeRecip)), protocolFee);

        // Caller paid: amount + protocolFee + OFT external fee
        // OFT fee = grossAmount - amount (1% inversion on 100e6 ≈ 1010102)
        uint256 callerSpent = callerBalBefore - token.balanceOf(caller);
        assertGt(callerSpent, amount + protocolFee); // more than amount + protocol fee
    }

    // ---- Initialize ----

    function test_initialize_approvesOft() public view {
        // Non-adapter OFT: initialize() should still set approval
        uint256 allowance = token.allowance(address(bridge), address(mockOft));
        assertEq(allowance, type(uint256).max);
    }
}

/**
 * @title TokenBridgeOftAdapterUnitTest
 * @notice Tests the OFTAdapter (lock/unlock) path where approvalRequired=true.
 */
contract TokenBridgeOftAdapterUnitTest is Test {
    uint32 constant DOMAIN_ETH = 1;
    uint32 constant LZ_EID_ETH = 30101;

    ERC20Test internal token;
    MockOFTAdapter internal mockAdapter;
    MockMailbox internal mailbox;
    TokenBridgeOft internal bridge;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        token = new ERC20Test("MockUSDC", "mUSDC", 0, 6);
        mockAdapter = new MockOFTAdapter(address(token));
        mailbox = new MockMailbox(1);
        bridge = new TokenBridgeOft(address(mockAdapter), address(mailbox));
        bridge.initialize(address(0), address(0), owner);

        vm.prank(owner);
        bridge.addDomain(DOMAIN_ETH, LZ_EID_ETH);

        token.mintTo(caller, 1_000e6);
        vm.deal(caller, 10 ether);
    }

    function test_constructor_approvesAdapter() public view {
        uint256 allowance = token.allowance(
            address(bridge),
            address(mockAdapter)
        );
        assertEq(allowance, type(uint256).max);
    }

    function test_transferRemote_adapter() public {
        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        bridge.transferRemote{value: 0.001 ether}(DOMAIN_ETH, recipient, 100e6);
        vm.stopPrank();

        // Adapter pulls tokens from bridge
        assertEq(token.balanceOf(caller), 900e6);
        assertEq(token.balanceOf(address(mockAdapter)), 100e6);
    }
}

/**
 * @title TokenBridgeOftFeeInversionTest
 * @notice Tests analytical fee inversion for OFTs with linear fees.
 */
contract TokenBridgeOftFeeInversionTest is Test {
    uint32 constant DOMAIN_ETH = 1;
    uint32 constant LZ_EID_ETH = 30101;

    ERC20Test internal token;
    MockOFT internal mockOft;
    MockMailbox internal mailbox;
    TokenBridgeOft internal bridge;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        token = new ERC20Test("MockUSDT", "mUSDT", 0, 6);
        mockOft = new MockOFT(address(token), false);
        mailbox = new MockMailbox(1);
        bridge = new TokenBridgeOft(address(mockOft), address(mailbox));
        bridge.initialize(address(0), address(0), owner);

        vm.prank(owner);
        bridge.addDomain(DOMAIN_ETH, LZ_EID_ETH);

        token.mintTo(caller, 1_000e6);
        vm.deal(caller, 10 ether);
    }

    function test_noFee_grossEqualsAmount() public view {
        // Default: no fee
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            100e6
        );
        // External fee (quotes[2]) should be 0
        assertEq(quotes[2].amount, 0, "no external fee when OFT has no fee");
    }

    function test_linearFee_externalFeeInQuote() public {
        // 1% fee (100 bps)
        mockOft.setFeeBps(100);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            100e6
        );

        // For 100e6 net amount with 1% fee:
        // Probe: send 100e6, receive 99e6
        // Gross = ceil(100e6 * 100e6 / 99e6) = 101010102
        // External fee = 101010102 - 100e6 = 1010102
        uint256 externalFee = quotes[2].amount;
        assertGt(externalFee, 0, "external fee should be positive");
        // Fee should be ~1% of net amount (slightly more due to inversion)
        assertApproxEqRel(externalFee, 1e6, 0.02e18); // within 2%
    }

    function test_linearFee_transferPullsGross() public {
        // 1% fee (100 bps)
        mockOft.setFeeBps(100);

        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        uint256 balBefore = token.balanceOf(caller);
        bridge.transferRemote{value: 0.001 ether}(DOMAIN_ETH, recipient, 100e6);
        vm.stopPrank();

        uint256 pulled = balBefore - token.balanceOf(caller);
        // Should pull more than 100e6 (gross = net + OFT fee)
        assertGt(pulled, 100e6, "should pull more than net amount");
        // Gross should be ~101.01e6
        assertApproxEqRel(pulled, 101010102, 0.001e18); // within 0.1%
    }

    function test_linearFee_6bps() public {
        // 6 bps fee (like Stargate-style)
        mockOft.setFeeBps(6);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            1_000e6 // 1000 USDT
        );

        uint256 externalFee = quotes[2].amount;
        // ~0.06% of 1000e6 = ~600_036 (0.6 USDT + inversion rounding)
        assertApproxEqRel(externalFee, 600361, 0.01e18);
    }

    function test_linearFee_zeroAmount() public {
        mockOft.setFeeBps(100);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            0
        );
        assertEq(quotes[2].amount, 0, "zero amount = zero fee");
    }

    function test_linearFee_100pct_reverts() public {
        mockOft.setFeeBps(10000); // 100% fee

        vm.expectRevert("TokenBridgeOft: OFT 100% fee");
        bridge.quoteTransferRemote(DOMAIN_ETH, recipient, 100e6);
    }
}

/**
 * @title TokenBridgeOftDustTest
 * @notice Tests dust handling for OFTs with localDecimals > sharedDecimals.
 * When localDecimals (18) > sharedDecimals (6), the OFT truncates
 * sub-sharedDecimals precision ("dust") via _removeDust(). Without
 * proper dust rounding, fee inversion produces dusty gross amounts
 * that cause SlippageExceeded reverts after the OFT's internal truncation.
 */
contract TokenBridgeOftDustTest is Test {
    uint32 constant DOMAIN_ETH = 1;
    uint32 constant LZ_EID_ETH = 30101;

    ERC20Test internal token;
    MockOFT internal mockOft;
    MockMailbox internal mailbox;
    TokenBridgeOft internal bridge;

    address internal owner = makeAddr("owner");
    address internal caller = makeAddr("caller");
    bytes32 internal recipient =
        bytes32(uint256(uint160(makeAddr("recipient"))));

    function setUp() public {
        // 18-decimal token with 6 shared decimals (conversion rate = 1e12)
        token = new ERC20Test("MockWETH", "mWETH", 0, 18);
        mockOft = new MockOFT(address(token), false);
        mockOft.setDecimals(18, 6);
        mailbox = new MockMailbox(1);
        bridge = new TokenBridgeOft(address(mockOft), address(mailbox));
        bridge.initialize(address(0), address(0), owner);

        vm.prank(owner);
        bridge.addDomain(DOMAIN_ETH, LZ_EID_ETH);

        token.mintTo(caller, 1_000e18);
        vm.deal(caller, 10 ether);
    }

    function test_dust_conversionRateSet() public view {
        assertEq(bridge.decimalConversionRate(), 1e12);
    }

    function test_dust_transferWithFee_doesNotRevert() public {
        // 1% fee — this is Devin's exact bug scenario
        mockOft.setFeeBps(100);

        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        // Without dust rounding, this would revert with SlippageExceeded
        bridge.transferRemote{value: 0.001 ether}(DOMAIN_ETH, recipient, 1e18);
        vm.stopPrank();
    }

    function test_dust_grossAmountIsDustFree() public {
        mockOft.setFeeBps(100);

        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            1e18
        );

        // grossAmount = _amount + externalFee, should be dust-free (divisible by 1e12)
        uint256 grossAmount = 1e18 + quotes[2].amount;
        assertEq(grossAmount % 1e12, 0, "gross amount must be dust-free");
    }

    function test_dust_noFee_dustyInputRoundedUp() public view {
        // Even with no fee, a dusty _amount should produce a dust-free gross
        // 1e18 + 1 has dust in the last 12 digits
        Quote[] memory quotes = bridge.quoteTransferRemote(
            DOMAIN_ETH,
            recipient,
            1e18 + 1
        );

        uint256 grossAmount = (1e18 + 1) + quotes[2].amount;
        assertEq(grossAmount % 1e12, 0, "dusty input rounded up to dust-free");
        // External fee should be the rounding cost
        assertGt(quotes[2].amount, 0, "rounding produces nonzero external fee");
    }
}
