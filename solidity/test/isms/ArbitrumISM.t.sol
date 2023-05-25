// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {ArbitrumISM} from "../../contracts/isms/native/ArbitrumISM.sol";
import {ArbitrumMessageHook} from "../../contracts/hooks/ArbitrumMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";
import {IBridge} from "@arbitrum/nitro-contracts/src/bridge/IBridge.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";

contract ArbitrumISMTest is Test {
    uint256 internal mainnetFork;
    uint256 internal arbitrumFork;

    Mailbox internal ethMailbox;
    Mailbox internal arbMailbox;

    TestMultisigIsm internal ism;

    uint8 internal constant VERSION = 0;

    address internal alice = address(0x1);

    address internal constant INBOX =
        0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f;
    address internal constant BRIDGE =
        0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a;

    IInbox internal arbitrumInbox;

    ArbitrumISM internal arbitrumISM;
    ArbitrumMessageHook internal arbitrumHook;

    TestRecipient internal testRecipient;
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

    event RelayedMessage(bytes32 indexed msgHash);

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        arbitrumFork = vm.createFork(vm.rpcUrl("arbitrum"));

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployEthMailbox() public {
        vm.selectFork(mainnetFork);

        ism = new TestMultisigIsm();

        arbitrumInbox = IInbox(INBOX);
        arbitrumHook = new ArbitrumMessageHook(
            ARBITRUM_DOMAIN,
            address(arbitrumInbox),
            address(ism)
        );

        // TEMPORARY
        vm.deal(address(arbitrumHook), 100 ether);

        ethMailbox = new Mailbox(MAINNET_DOMAIN);
        ethMailbox.initialize(address(this), address(ism));

        vm.makePersistent(address(ethMailbox));
    }

    function deployArbMailbox() public {
        vm.selectFork(arbitrumFork);

        arbMailbox = new Mailbox(ARBITRUM_DOMAIN);
        arbMailbox.initialize(address(this), address(arbitrumISM));

        vm.makePersistent(address(arbMailbox));
    }

    function deployArbitrumISM() public {
        vm.selectFork(arbitrumFork);

        arbitrumISM = new ArbitrumISM();

        vm.makePersistent(address(arbitrumISM));
    }

    function deployAll() public {
        deployArbitrumISM();
        deployEthMailbox();
        deployArbMailbox();

        vm.selectFork(arbitrumFork);
        arbitrumISM.setArbitrumHook(address(arbitrumHook));
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    function testDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = keccak256(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            ArbitrumISM.receiveFromHook,
            (address(this), messageId)
        );

        bytes memory encodedMessageData = abi.encodePacked(
            uint256(uint160(address(arbitrumISM))),
            address(this),
            encodedHookData
        );

        ethMailbox.dispatch(
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );

        uint256 messageCountBefore = IBridge(BRIDGE).delayedMessageCount();

        // TODO: need approximate emits for submission fees abi-encoded
        vm.expectEmit(false, false, false, false, INBOX);
        emit InboxMessageDelivered(0, encodedMessageData);

        vm.expectEmit(true, true, true, false, address(arbitrumHook));
        emit ArbitrumMessagePublished(address(this), messageId, 1e13);

        arbitrumHook.postDispatch(ARBITRUM_DOMAIN, messageId);

        uint256 messageCountAfter = IBridge(BRIDGE).delayedMessageCount();

        assertEq(messageCountAfter, messageCountBefore + 1);
    }

    function testDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        ethMailbox.dispatch(
            42162,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
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

        ethMailbox.dispatch(
            ARBITRUM_DOMAIN,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert();
        arbitrumHook.postDispatch(ARBITRUM_DOMAIN, messageId);
    }

    /* ============ ISM.receiveFromHook ============ */

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 _messageId = keccak256(
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

    function testReceiveFromHook_ArbRetryableTx() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 _messageId = keccak256(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(address(arbitrumHook))
        );

        // TODO
        // create a RetryableTicket
        // redeem it from aliased address

        arbitrumISM.receiveFromHook(address(this), _messageId);

        assertEq(arbitrumISM.receivedEmitters(_messageId, address(this)), true);

        vm.stopPrank();
    }

    function testReceiveFromHook_NotAuthorized() public {
        deployAll();

        vm.selectFork(arbitrumFork);

        bytes32 _messageId = keccak256(
            _encodeTestMessage(0, address(testRecipient))
        );

        // needs to be called by the cannonical messenger on Optimism
        vm.expectRevert("ArbitrumISM: caller is not authorized.");
        arbitrumISM.receiveFromHook(address(arbitrumHook), _messageId);

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
        bytes32 _messageId = keccak256(encodedMessage);

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
        bytes32 _messageId = keccak256(encodedMessage);

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
