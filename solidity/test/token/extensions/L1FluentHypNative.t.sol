// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {HypNative} from "../../../contracts/token/HypNative.sol";
import {TokenMessage} from "../../../contracts/token/libs/TokenMessage.sol";
import {TypeCasts} from "../../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../../contracts/mock/MockMailbox.sol";
import {LinearFee} from "../../../contracts/token/fees/LinearFee.sol";
import {Quote} from "../../../contracts/interfaces/ITokenBridge.sol";
import {IL1HypNativeGateway, L1FluentHypNative} from "../../../contracts/token/extensions/L1FluentHypNative.sol";

/// @dev Records the last call and can be toggled to revert with a typed selector.
contract MockL1HypNativeGateway is IL1HypNativeGateway {
    error GatewayPaused();

    bool public shouldRevert;
    uint256 public callCount;
    address public lastTo;
    uint256 public lastValue;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function sendNativeTokens(address to) external payable override {
        if (shouldRevert) revert GatewayPaused();
        callCount++;
        lastTo = to;
        lastValue = msg.value;
    }
}

contract L1FluentHypNativeTest is Test {
    using TypeCasts for address;

    uint32 internal constant ORIGIN = 11;
    uint32 internal constant L1_DOMAIN = 12;
    uint256 internal constant SCALE = 1;
    uint256 internal constant TRANSFER_AMOUNT = 1 ether;

    address internal alice = makeAddr("alice");
    address internal proxyAdmin = makeAddr("proxyAdmin");
    bytes32 internal remoteRouter =
        TypeCasts.addressToBytes32(makeAddr("remoteRouter"));

    MockMailbox internal mailbox;
    MockL1HypNativeGateway internal gateway;
    L1FluentHypNative internal warpRoute;

    event ReceivedTransferRemote(
        uint32 indexed origin,
        bytes32 indexed recipient,
        uint256 amount
    );

    function setUp() public {
        mailbox = new MockMailbox(L1_DOMAIN);
        // Self-link for dispatch: we only validate inbound semantics here, so the
        // outbound message just needs somewhere to land (MockMailbox refuses dispatch
        // to an unconfigured remote).
        mailbox.addRemoteMailbox(ORIGIN, mailbox);
        gateway = new MockL1HypNativeGateway();

        warpRoute = _deploy(SCALE, SCALE, address(gateway));
        warpRoute.enrollRemoteRouter(ORIGIN, remoteRouter);
    }

    function _deploy(
        uint256 _scaleN,
        uint256 _scaleD,
        address _gateway
    ) internal returns (L1FluentHypNative) {
        L1FluentHypNative impl = new L1FluentHypNative(
            _scaleN,
            _scaleD,
            address(mailbox),
            _gateway
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(impl),
            proxyAdmin,
            abi.encodeCall(
                HypNative.initialize,
                (address(0), address(0), address(this))
            )
        );
        return L1FluentHypNative(payable(proxy));
    }

    function _handleAsMailbox(
        uint256 _messageAmount,
        address _recipient
    ) internal {
        bytes memory body = TokenMessage.format(
            _recipient.addressToBytes32(),
            _messageAmount
        );
        vm.prank(address(mailbox));
        warpRoute.handle(ORIGIN, remoteRouter, body);
    }

    // ====================================================
    // Constructor
    // ====================================================

    function test_RevertIf_constructor_zeroGateway() public {
        vm.expectRevert(L1FluentHypNative.GatewayAddressZero.selector);
        new L1FluentHypNative(SCALE, SCALE, address(mailbox), address(0));
    }

    function test_constructor_storesImmutables() public view {
        assertEq(
            address(warpRoute.l1HypNativeGateway()),
            address(gateway),
            "gateway immutable"
        );
        assertEq(warpRoute.token(), address(0), "native token sentinel");
    }

    // ====================================================
    // _handle: happy path
    // ====================================================

    function test_handle_forwardsToL2() public {
        vm.deal(address(warpRoute), TRANSFER_AMOUNT);

        vm.expectEmit(true, true, true, true, address(warpRoute));
        emit ReceivedTransferRemote(
            ORIGIN,
            alice.addressToBytes32(),
            TRANSFER_AMOUNT
        );

        _handleAsMailbox(TRANSFER_AMOUNT, alice);

        assertEq(gateway.callCount(), 1, "gateway called once");
        assertEq(gateway.lastTo(), alice, "gateway called with L2 recipient");
        assertEq(
            gateway.lastValue(),
            TRANSFER_AMOUNT,
            "gateway received full transfer amount"
        );
        assertEq(
            address(warpRoute).balance,
            0,
            "warp route balance drained to gateway"
        );
        assertEq(
            address(gateway).balance,
            TRANSFER_AMOUNT,
            "gateway holds forwarded native"
        );
    }

    // ====================================================
    // _handle: gateway revert + retry semantics
    // ====================================================

    function test_RevertIf_handle_gatewayReverts() public {
        vm.deal(address(warpRoute), TRANSFER_AMOUNT);
        gateway.setShouldRevert(true);

        vm.prank(address(mailbox));
        vm.expectRevert(MockL1HypNativeGateway.GatewayPaused.selector);
        warpRoute.handle(
            ORIGIN,
            remoteRouter,
            TokenMessage.format(alice.addressToBytes32(), TRANSFER_AMOUNT)
        );

        // Funds remain in the warp route — Mailbox.process rolls back atomically.
        assertEq(
            address(warpRoute).balance,
            TRANSFER_AMOUNT,
            "funds retained on revert"
        );
        assertEq(gateway.callCount(), 0, "gateway not called");
    }

    /// @dev A malformed source-chain dispatch with `recipient == address(0)` must fail
    /// fast at the warp route with a typed error, instead of cycling through the
    /// gateway's `InvalidRecipient` revert on every retry forever.
    function test_RevertIf_handle_zeroRecipient() public {
        vm.deal(address(warpRoute), TRANSFER_AMOUNT);

        vm.prank(address(mailbox));
        vm.expectRevert(L1FluentHypNative.ZeroRecipient.selector);
        warpRoute.handle(
            ORIGIN,
            remoteRouter,
            TokenMessage.format(bytes32(0), TRANSFER_AMOUNT)
        );

        assertEq(
            address(warpRoute).balance,
            TRANSFER_AMOUNT,
            "funds retained on zero-recipient revert"
        );
        assertEq(
            gateway.callCount(),
            0,
            "gateway not called for zero-recipient message"
        );
    }

    /// @dev Locks down the revert-and-retry design: a transient gateway failure
    /// must not strand funds; the same message can be re-delivered after the
    /// gateway recovers and proceeds end-to-end.
    function test_handle_retryAfterTransientFailure() public {
        vm.deal(address(warpRoute), TRANSFER_AMOUNT);

        // First attempt: gateway paused → handle reverts, funds stay.
        gateway.setShouldRevert(true);
        vm.prank(address(mailbox));
        vm.expectRevert(MockL1HypNativeGateway.GatewayPaused.selector);
        warpRoute.handle(
            ORIGIN,
            remoteRouter,
            TokenMessage.format(alice.addressToBytes32(), TRANSFER_AMOUNT)
        );
        assertEq(
            address(warpRoute).balance,
            TRANSFER_AMOUNT,
            "funds retained on first attempt"
        );
        assertEq(gateway.callCount(), 0, "gateway not called on first attempt");

        // Operator unpauses the gateway and retries the same message.
        gateway.setShouldRevert(false);
        _handleAsMailbox(TRANSFER_AMOUNT, alice);

        assertEq(gateway.callCount(), 1, "gateway called on retry");
        assertEq(
            gateway.lastValue(),
            TRANSFER_AMOUNT,
            "retry forwards full amount"
        );
        assertEq(address(warpRoute).balance, 0, "funds drained on retry");
        assertEq(
            address(gateway).balance,
            TRANSFER_AMOUNT,
            "gateway holds forwarded native after retry"
        );
    }

    // ====================================================
    // _transferFee stays on L1
    // ====================================================

    /// @dev With a fee recipient configured, the protocol fee charged on an
    /// outbound `transferRemote` must land on the L1 fee contract — it must
    /// not be forwarded through the gateway to L2.
    function test_transferFee_staysOnL1() public {
        uint256 feeAmount = 0.1 ether;
        LinearFee feeContract = new LinearFee(
            address(0), // native token
            feeAmount,
            TRANSFER_AMOUNT, // halfAmount: produces feeAmount/2 at TRANSFER_AMOUNT
            address(this)
        );
        warpRoute.setFeeRecipient(address(feeContract));

        // LinearFee with maxFee=feeAmount and halfAmount=TRANSFER_AMOUNT yields
        // (TRANSFER_AMOUNT * feeAmount) / (2 * TRANSFER_AMOUNT) = feeAmount / 2.
        uint256 expectedFee = feeAmount / 2;

        Quote[] memory quotes = warpRoute.quoteTransferRemote(
            ORIGIN,
            alice.addressToBytes32(),
            TRANSFER_AMOUNT
        );
        assertEq(
            quotes[1].amount,
            TRANSFER_AMOUNT + expectedFee,
            "quote includes internal fee"
        );

        uint256 mailboxGas = quotes[0].amount;
        uint256 totalValue = mailboxGas + TRANSFER_AMOUNT + expectedFee;

        uint256 gatewayBalanceBefore = address(gateway).balance;
        uint256 feeContractBalanceBefore = address(feeContract).balance;

        vm.deal(alice, totalValue);
        vm.prank(alice);
        warpRoute.transferRemote{value: totalValue}(
            ORIGIN,
            alice.addressToBytes32(),
            TRANSFER_AMOUNT
        );

        // Fee landed on L1 (fee contract), not on the gateway.
        assertEq(
            address(feeContract).balance - feeContractBalanceBefore,
            expectedFee,
            "fee lands on L1 fee contract"
        );
        assertEq(
            address(gateway).balance,
            gatewayBalanceBefore,
            "no funds forwarded to gateway on outbound"
        );
    }

    receive() external payable {}
}
