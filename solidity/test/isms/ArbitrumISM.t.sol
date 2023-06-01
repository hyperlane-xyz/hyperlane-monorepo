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

import {MockArbSys} from "./arbitrum/MockArbSys.sol";

import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {IBridge} from "@arbitrum/nitro-contracts/src/bridge/IBridge.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";

contract ArbitrumISMTest is Test {
    uint256 internal mainnetFork;
    uint256 internal arbitrumFork;

    uint8 internal constant VERSION = 0;

    address internal alice = address(0x1);

    address internal constant INBOX =
        0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f;
    address internal constant BRIDGE =
        0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a;
    address internal constant ARB_SYS_ADDRESS =
        0x0000000000000000000000000000000000000064;

    IInbox internal arbitrumInbox;

    ArbitrumISM internal arbitrumISM;
    ArbitrumMessageHook internal arbitrumHook;

    TestRecipient internal testRecipient;
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

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

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

        // TEMPORARY
        vm.deal(address(arbitrumHook), 100 ether);

        vm.makePersistent(address(arbitrumHook));
    }

    function deployArbitrumISM() public {
        vm.selectFork(arbitrumFork);

        mockArbSys = new MockArbSys();
        vm.etch(ARB_SYS_ADDRESS, address(mockArbSys).code);
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
        console.log("l1: ", submissionFee);

        uint256 totalGasCost = submissionFee + 26_000 * 1e8;

        // TODO: need approximate emits for submission fees abi-encoded
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

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 _messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook))
        );

        vm.expectEmit(true, true, false, false, address(arbitrumISM));
        emit ReceivedMessage(_messageId, address(this));

        arbitrumISM.receiveFromHook(address(this), _messageId);

        assertEq(arbitrumISM.receivedEmitters(_messageId, address(this)), true);

        vm.stopPrank();
    }

    function testReceiveFromHook_NotAuthorized() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 _messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.prank(address(arbitrumHook));

        vm.expectRevert("ArbitrumISM: caller is not authorized.");
        arbitrumISM.receiveFromHook(address(arbitrumHook), _messageId);
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

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
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

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
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

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
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

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook)));
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
}
