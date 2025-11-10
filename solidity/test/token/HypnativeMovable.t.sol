// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import {ITokenBridge, Quote} from "contracts/interfaces/ITokenBridge.sol";
import {HypNative} from "contracts/token/HypNative.sol";
import {MockITokenBridge} from "./MovableCollateralRouter.t.sol";

import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {MockMailbox} from "contracts/mock/MockMailbox.sol";
import {LinearFee} from "contracts/token/fees/LinearFee.sol";

import "forge-std/Test.sol";

contract MockITokenBridgeEth is ITokenBridge {
    uint256 public quoteLength;
    address public quoteToken;
    uint256 public quoteAmount;

    constructor() {
        quoteLength = 0;
    }

    function setQuote(
        uint256 _length,
        address _token,
        uint256 _amount
    ) external {
        quoteLength = _length;
        quoteToken = _token;
        quoteAmount = _amount;
    }

    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32 transferId) {
        return keccak256("fake message");
    }

    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external view override returns (Quote[] memory) {
        Quote[] memory quotes = new Quote[](quoteLength);
        if (quoteLength == 1) {
            quotes[0] = Quote({token: quoteToken, amount: quoteAmount});
        } else if (quoteLength > 1) {
            // Return multiple quotes for testing
            quotes[0] = Quote({token: quoteToken, amount: quoteAmount});
            quotes[1] = Quote({token: address(0), amount: 100});
        }
        return quotes;
    }
}

contract HypNativeMovableTest is Test {
    HypNative internal router;
    HypNative internal vtb;
    ERC20Test internal token;
    uint32 internal constant destinationDomain = 2;
    address internal constant alice = address(1);

    function setUp() public {
        token = new ERC20Test("Foo Token", "FT", 1_000_000e18, 18);
        address mailbox = address(new MockMailbox(uint32(1)));
        MockMailbox(mailbox).addRemoteMailbox(
            destinationDomain,
            MockMailbox(mailbox)
        );
        router = new HypNative(1, mailbox);
        // Initialize the router -> we are the admin
        router.initialize(address(0), address(0), address(this));
        router.enrollRemoteRouter(
            destinationDomain,
            bytes32(uint256(uint160(0)))
        );
        vtb = new HypNative(1, mailbox);
        vtb.enrollRemoteRouter(destinationDomain, bytes32(uint256(uint160(0))));
    }

    function test_rebalance() public {
        // Configuration
        router.addRebalancer(address(this));

        // Add the destination domain
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );

        // Add the given bridge
        router.addBridge(destinationDomain, vtb);

        // Setup - send ether to router
        deal(address(router), 1 ether);

        // Execute
        router.rebalance(destinationDomain, 1 ether, vtb);
        // Assert
        assertEq(address(router).balance, 0);
        assertEq(address(vtb).balance, 1 ether);
    }

    function test_rebalance_NotEnoughBalance() public {
        router.addRebalancer(address(this));
        router.setRecipient(
            destinationDomain,
            bytes32(uint256(uint160(alice)))
        );
        router.addBridge(destinationDomain, vtb);
        vm.expectRevert("Rebalance native fee exceeds balance");
        router.rebalance(destinationDomain, 1 ether, vtb);
    }

    function test_rebalance_cannotUndercollateralize(
        uint96 fee,
        uint96 amount,
        uint96 balance
    ) public {
        vm.assume(balance > 2);
        amount = uint96(bound(uint256(amount), 2, uint256(balance)));
        fee = uint96(bound(uint256(fee), 1, uint256(amount)));

        vtb.setFeeRecipient(
            address(new LinearFee(address(0), fee, amount / 2, address(this)))
        );

        router.addRebalancer(address(this));
        router.addBridge(destinationDomain, vtb);

        deal(address(router), balance);
        deal(address(this), fee);

        router.rebalance{value: fee}(destinationDomain, amount, vtb);
        assertEq(address(router).balance, balance - amount);
        assertEq(address(vtb).balance, amount);
    }

    function test_setFeeRecipient_cannotSetToSelf() public {
        vm.expectRevert("Fee recipient cannot be self");
        router.setFeeRecipient(address(router));
    }

    function test_setFeeRecipient_canSetToOtherAddress() public {
        address feeRecipient = address(0x123);
        router.setFeeRecipient(feeRecipient);
        assertEq(router.feeRecipient(), feeRecipient);
    }

    function test_setFeeRecipient_canSetToZeroAddress() public {
        router.setFeeRecipient(address(0x123));
        assertEq(router.feeRecipient(), address(0x123));

        router.setFeeRecipient(address(0));
        assertEq(router.feeRecipient(), address(0));
    }

    function test_feeRecipient_emptyQuotesReturnsZero() public {
        MockITokenBridgeEth mockFeeRecipient = new MockITokenBridgeEth();
        // Set to return empty quotes (length 0)
        mockFeeRecipient.setQuote(0, address(0), 0);

        router.setFeeRecipient(address(mockFeeRecipient));

        // Should not revert and return 0 fee
        Quote[] memory quotes = router.quoteTransferRemote(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1 ether
        );

        // quotes[1] is the internal fee (amount + fee)
        assertEq(quotes[1].amount, 1 ether); // no fee added
    }

    function test_feeRecipient_multipleQuotesReverts() public {
        MockITokenBridgeEth mockFeeRecipient = new MockITokenBridgeEth();
        // Set to return 2 quotes (invalid)
        mockFeeRecipient.setQuote(2, address(0), 0.1 ether);

        router.setFeeRecipient(address(mockFeeRecipient));

        // Should revert with the fee mismatch error
        vm.expectRevert("FungibleTokenRouter: fee must match token");
        router.quoteTransferRemote(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1 ether
        );
    }

    function test_feeRecipient_wrongTokenReverts() public {
        MockITokenBridgeEth mockFeeRecipient = new MockITokenBridgeEth();
        // Set to return 1 quote but with wrong token (not address(0) which is the native token)
        address wrongToken = address(0x456);
        mockFeeRecipient.setQuote(1, wrongToken, 0.1 ether);

        router.setFeeRecipient(address(mockFeeRecipient));

        // Should revert with the fee mismatch error
        vm.expectRevert("FungibleTokenRouter: fee must match token");
        router.quoteTransferRemote(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1 ether
        );
    }

    function test_feeRecipient_correctTokenSucceeds() public {
        MockITokenBridgeEth mockFeeRecipient = new MockITokenBridgeEth();
        // Set to return 1 quote with correct token (address(0) for native)
        mockFeeRecipient.setQuote(1, address(0), 0.1 ether);

        router.setFeeRecipient(address(mockFeeRecipient));

        // Should succeed and return correct fee
        Quote[] memory quotes = router.quoteTransferRemote(
            destinationDomain,
            bytes32(uint256(uint160(alice))),
            1 ether
        );

        // quotes[1] is the internal fee (amount + fee)
        assertEq(quotes[1].amount, 1.1 ether); // 1 ether + 0.1 ether fee
    }
}
