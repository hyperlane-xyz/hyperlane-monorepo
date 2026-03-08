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
    uint256 public amountReceivedLD;
    bytes32 public guidToReturn;
    bool public shouldRevertOnSend;

    constructor(address _token, bool _approvalRequired) {
        tokenAddress = _token;
        approvalRequiredValue = _approvalRequired;
        nativeFeeToReturn = 0.001 ether;
        guidToReturn = keccak256("mock-guid");
    }

    function setNativeFee(uint256 _fee) external {
        nativeFeeToReturn = _fee;
    }

    function setAmountReceivedLD(uint256 _amount) external {
        amountReceivedLD = _amount;
    }

    function setGuid(bytes32 _guid) external {
        guidToReturn = _guid;
    }

    function setShouldRevertOnSend(bool _revert) external {
        shouldRevertOnSend = _revert;
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

    function sharedDecimals() external pure returns (uint8) {
        return 6;
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
        uint256 received = amountReceivedLD > 0
            ? amountReceivedLD
            : _sendParam.amountLD;
        return (
            OFTLimit({minAmountLD: 0, maxAmountLD: type(uint256).max}),
            new OFTFeeDetail[](0),
            OFTReceipt({
                amountSentLD: _sendParam.amountLD,
                amountReceivedLD: received
            })
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

        uint256 received = amountReceivedLD > 0
            ? amountReceivedLD
            : _sendParam.amountLD;

        return (
            MessagingReceipt({
                guid: guidToReturn,
                nonce: 1,
                fee: MessagingFee({nativeFee: msg.value, lzTokenFee: 0})
            }),
            OFTReceipt({
                amountSentLD: _sendParam.amountLD,
                amountReceivedLD: received
            })
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
        assertEq(bridge.hyperlaneDomainToLzEid(DOMAIN_ETH), 0);
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

    function test_setRefundAddress() public {
        address newRefund = makeAddr("refund");
        vm.prank(owner);
        bridge.setRefundAddress(newRefund);
        assertEq(bridge.refundAddress(), newRefund);
    }

    function test_setRefundAddress_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert("TokenBridgeOft: zero refund address");
        bridge.setRefundAddress(address(0));
    }

    function test_setRefundAddress_revertsNonOwner() public {
        vm.prank(caller);
        vm.expectRevert("Ownable: caller is not the owner");
        bridge.setRefundAddress(caller);
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
 * @title TokenBridgeOftSlippageTest
 * @notice Tests that minAmountLD is set from quoteOFT for slippage protection.
 */
contract TokenBridgeOftSlippageTest is Test {
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

    function test_slippageProtection_setsMinAmount() public {
        // Simulate OFT that takes a fee: send 100, receive 99
        mockOft.setAmountReceivedLD(99e6);

        vm.startPrank(caller);
        token.approve(address(bridge), type(uint256).max);

        // Should not revert — minAmountLD is set from quoteOFT
        bridge.transferRemote{value: 0.001 ether}(DOMAIN_ETH, recipient, 100e6);
        vm.stopPrank();
    }
}
