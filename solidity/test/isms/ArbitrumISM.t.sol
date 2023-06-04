// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {ArbitrumISM} from "../../contracts/isms/native/ArbitrumISM.sol";
import {ArbitrumMessageHook} from "../../contracts/hooks/ArbitrumMessageHook.sol";
import {IInterchainGasPaymaster} from "../../contracts/interfaces/IInterchainGasPaymaster.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {MockArbRetryableTx} from "./arbitrum/MockArbRetryableTx.sol";
import {MockArbSys} from "./arbitrum/MockArbSys.sol";

import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {IBridge} from "@arbitrum/nitro-contracts/src/bridge/IBridge.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";

contract ArbitrumISMTest is Test {
    uint256 internal mainnetFork;
    uint256 internal arbitrumFork;

    uint8 internal constant VERSION = 0;

    address internal alice = address(0x1);
    address internal bob = address(0x2);

    address internal constant INBOX =
        0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f;
    address internal constant BRIDGE =
        0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a;
    address internal constant ARB_SYS_ADDRESS =
        0x0000000000000000000000000000000000000064;
    address internal constant ARB_RETRYABLE_TX_ADDRESS =
        0x000000000000000000000000000000000000006E;

    IInbox internal arbitrumInbox;

    ArbitrumISM internal arbitrumISM;
    ArbitrumMessageHook internal arbitrumHook;

    TestRecipient internal testRecipient;
    MockArbRetryableTx internal mockArbRetryableTx;
    MockArbSys internal mockArbSys;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 42161;

    event ArbitrumMessagePublished(
        address indexed sender,
        bytes32 indexed messageId,
        uint256 gasOverhead
    );

    event InboxMessageDelivered(uint256 indexed messageNum, bytes data);

    event ReceivedMessage(address indexed emitter, bytes32 indexed messageId);

    error NotCrossChainCall();

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        arbitrumFork = vm.createFork(vm.rpcUrl("arbitrum"));

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployArbitrumHook() public {
        vm.selectFork(mainnetFork);

        arbitrumInbox = IInbox(INBOX);

        arbitrumHook = new ArbitrumMessageHook(
            ARBITRUM_DOMAIN,
            INBOX,
            address(arbitrumISM)
        );

        vm.makePersistent(address(arbitrumHook));
    }

    function deployArbitrumISM() public {
        vm.selectFork(arbitrumFork);

        mockArbSys = new MockArbSys();
        vm.etch(ARB_SYS_ADDRESS, address(mockArbSys).code);

        mockArbRetryableTx = new MockArbRetryableTx();
        vm.etch(ARB_RETRYABLE_TX_ADDRESS, address(mockArbRetryableTx).code);

        arbitrumISM = new ArbitrumISM();

        vm.makePersistent(address(arbitrumISM));
    }

    function deployAll() public {
        deployArbitrumISM();
        deployArbitrumHook();

        vm.selectFork(arbitrumFork);
        arbitrumISM.setArbitrumHook(address(arbitrumHook));
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    function testContructor_NotContract() public {
        vm.selectFork(mainnetFork);

        arbitrumInbox = IInbox(INBOX);

        vm.expectRevert("ArbitrumHook: invalid ISM");
        arbitrumHook = new ArbitrumMessageHook(ARBITRUM_DOMAIN, INBOX, alice);
    }

    function testDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            ArbitrumISM.receiveFromHook,
            (address(this), messageId)
        );

        bytes memory encodedMessageData = abi.encodePacked(
            uint256(uint160(address(arbitrumISM))),
            address(this),
            encodedHookData
        );

        uint256 messageCountBefore = IBridge(BRIDGE).delayedMessageCount();

        uint256 submissionFee = arbitrumInbox.calculateRetryableSubmissionFee(
            68,
            0
        );
        uint256 totalGasCost = submissionFee + 26_000 * 1e8;

        vm.expectEmit(false, false, false, false, INBOX);
        emit InboxMessageDelivered(0, encodedMessageData);

        vm.expectEmit(true, true, true, false, address(arbitrumHook));
        emit ArbitrumMessagePublished(address(this), messageId, totalGasCost);

        arbitrumHook.postDispatch{value: totalGasCost}(
            ARBITRUM_DOMAIN,
            messageId
        );

        uint256 messageCountAfter = IBridge(BRIDGE).delayedMessageCount();

        assertEq(messageCountAfter, messageCountBefore + 1);
    }

    function testDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert("ArbitrumHook: invalid destination domain");
        arbitrumHook.postDispatch(11, messageId);
    }

    function testDispatch_InsufficientFunds() public {
        deployAll();

        vm.selectFork(mainnetFork);
        vm.deal(address(arbitrumHook), 0 ether);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert("ArbitrumHook: insufficient funds");
        arbitrumHook.postDispatch(ARBITRUM_DOMAIN, messageId);
    }

    /* ============ ISM.receiveFromHook ============ */

    function testReceiveFromHook() public payable {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            ArbitrumISM.receiveFromHook,
            (address(this), messageId)
        );
        _createTicket(encodedHookData, 26000);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));

        bytes32 ticketId = MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS)
            .getTicketId(0);

        vm.expectEmit(true, true, false, false, address(arbitrumISM));
        emit ReceivedMessage(address(this), messageId);

        MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS).redeem(ticketId);

        assertEq(arbitrumISM.receivedEmitters(messageId, address(this)), true);

        vm.stopPrank();
    }

    function testReceiveFromHook_WithValue() public {
        deployAll();
        vm.selectFork(arbitrumFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            ArbitrumISM.receiveFromHook,
            (address(this), messageId)
        );
        _createTicket(encodedHookData, 26000);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));

        bytes32 ticketId = MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS)
            .getTicketId(0);
        uint256 aliceBefore = alice.balance;

        MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS).redeem(ticketId);

        assertEq(bob.balance, 1 ether);
        assertEq(alice.balance, aliceBefore + 1000);

        vm.stopPrank();
    }

    function testReceiveFromHook_FailedRedeem() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            ArbitrumISM.receiveFromHook,
            (address(this), messageId)
        );
        _createTicket(encodedHookData, 24000);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));

        bytes32 ticketId = MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS)
            .getTicketId(0);

        vm.expectRevert("L2 gas limit exceeded");

        MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS).redeem(ticketId);

        assertFalse(arbitrumISM.receivedEmitters(messageId, address(this)));

        vm.stopPrank();
    }

    function testReceiveFromHook_NotAuthorized() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            ArbitrumISM.receiveFromHook,
            (address(this), messageId)
        );
        _createTicket(encodedHookData, 26000);

        _startHoax(address(arbitrumHook));

        bytes32 ticketId = MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS)
            .getTicketId(0);

        vm.expectRevert("L2 call failed");

        MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS).redeem(ticketId);

        assertFalse(arbitrumISM.receivedEmitters(messageId, address(this)));

        vm.stopPrank();
    }

    /* ============ ISM.verify ============ */

    function testVerify() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
        arbitrumISM.receiveFromHook(address(this), _messageId);

        bool verified = arbitrumISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    function testVerify_InvalidMessage_Hyperlane() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
        arbitrumISM.receiveFromHook(address(this), _messageId);

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = arbitrumISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    function testVerify_InvalidMessageID_Optimism() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bytes32 _messageId = Message.id(invalidMessage);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
        arbitrumISM.receiveFromHook(address(this), _messageId);

        bool verified = arbitrumISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    function testVerify_InvalidSender() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        _startHoax(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
        arbitrumISM.receiveFromHook(alice, _messageId);

        bool verified = arbitrumISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage(uint32 _msgCount, address _receipient)
        internal
        view
        returns (bytes memory encodedMessage)
    {
        encodedMessage = abi.encodePacked(
            VERSION,
            _msgCount,
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(_receipient),
            testMessage
        );
    }

    function _startHoax(address _toPrankWith) internal {
        MockArbSys(ARB_SYS_ADDRESS).setCallerAddress(_toPrankWith);
        vm.startPrank(_toPrankWith);
    }

    function _createTicket(bytes memory encodedCall, uint256 _gasLimit)
        internal
    {
        uint256 maxSubmissionCost = 30_539688041744;

        vm.selectFork(mainnetFork);

        uint256 gasOverhead = arbitrumHook.getGasOverhead(encodedCall);
        uint256 msgValue = gasOverhead + 1e18;

        vm.selectFork(arbitrumFork);

        MockArbRetryableTx(ARB_RETRYABLE_TX_ADDRESS)
            .mockUnsafeCreateRetryableTicket{value: msgValue}(
            address(arbitrumISM),
            1e18,
            maxSubmissionCost,
            address(alice),
            address(bob),
            _gasLimit,
            1e8,
            encodedCall
        );
    }
}
