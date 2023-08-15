// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {OPStackIsm} from "../../contracts/isms/hook/OPStackIsm.sol";
import {OPStackHook} from "../../contracts/hooks/OPStackHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {NotCrossChainCall} from "../../contracts/isms/hook/crossChainEnabled/errors.sol";

import {Lib_CrossDomainUtils} from "@eth-optimism/contracts/libraries/bridge/Lib_CrossDomainUtils.sol";
import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {ICanonicalTransactionChain} from "@eth-optimism/contracts/L1/rollup/ICanonicalTransactionChain.sol";
import {L2CrossDomainMessenger} from "@eth-optimism/contracts-bedrock/contracts/L2/L2CrossDomainMessenger.sol";
import {Encoding} from "@eth-optimism/contracts-bedrock/contracts/libraries/Encoding.sol";
import {Hashing} from "@eth-optimism/contracts-bedrock/contracts/libraries/Hashing.sol";

contract OPStackIsmTest is Test {
    using LibBit for uint256;
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint256 internal mainnetFork;
    uint256 internal optimismFork;

    address internal constant L1_MESSENGER_ADDRESS =
        0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1;
    address internal constant L1_CANNONICAL_CHAIN =
        0x5E4e65926BA27467555EB562121fac00D24E9dD2;
    address internal constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    uint8 internal constant VERSION = 0;
    uint256 internal constant DEFAULT_GAS_LIMIT = 1_920_000;

    address internal alice = address(0x1);

    ICrossDomainMessenger internal l1Messenger;
    L2CrossDomainMessenger internal l2Messenger;
    TestMailbox internal l1Mailbox;
    OPStackIsm internal opISM;
    OPStackHook internal opHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata = abi.encodePacked(uint256(0));

    bytes internal encodedMessage;
    bytes32 internal messageId;

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant OPTIMISM_DOMAIN = 10;

    event SentMessage(
        address indexed target,
        address sender,
        bytes message,
        uint256 messageNonce,
        uint256 gasLimit
    );

    event RelayedMessage(bytes32 indexed msgHash);

    event FailedRelayedMessage(bytes32 indexed msgHash);

    event ReceivedMessage(bytes32 indexed messageId);

    function setUp() public {
        // block numbers to fork from, chain data is cached to ../../forge-cache/
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 17_586_909);
        optimismFork = vm.createFork(vm.rpcUrl("optimism"), 106_233_774);

        testRecipient = new TestRecipient();

        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployOptimismHook() public {
        vm.selectFork(mainnetFork);

        l1Messenger = ICrossDomainMessenger(L1_MESSENGER_ADDRESS);
        l1Mailbox = new TestMailbox(MAINNET_DOMAIN);

        opHook = new OPStackHook(
            address(l1Mailbox),
            OPTIMISM_DOMAIN,
            address(opISM),
            L1_MESSENGER_ADDRESS
        );

        vm.makePersistent(address(opHook));
    }

    function deployOPStackIsm() public {
        vm.selectFork(optimismFork);

        l2Messenger = L2CrossDomainMessenger(L2_MESSENGER_ADDRESS);
        opISM = new OPStackIsm(L2_MESSENGER_ADDRESS);

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOPStackIsm();
        deployOptimismHook();

        vm.selectFork(optimismFork);

        opISM.setAuthorizedHook(address(opHook));
        // for sending value
        vm.deal(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS),
            2**255
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    function testFork_postDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        uint40 nonce = ICanonicalTransactionChain(L1_CANNONICAL_CHAIN)
            .getQueueLength();

        l1Mailbox.updateLatestDispatchedId(messageId);

        vm.expectEmit(true, true, true, false, L1_MESSENGER_ADDRESS);
        emit SentMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nonce,
            DEFAULT_GAS_LIMIT
        );
        opHook.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory message = MessageUtils.formatMessage(
            VERSION,
            uint32(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            11, // wrong domain
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );

        l1Mailbox.updateLatestDispatchedId(Message.id(message));
        vm.expectRevert(
            "AbstractMessageIdAuthHook: invalid destination domain"
        );
        opHook.postDispatch(testMetadata, message);
    }

    function testFork_postDispatch_RevertWhen_TooMuchValue() public {
        deployAll();

        vm.selectFork(mainnetFork);

        vm.deal(address(this), uint256(2**255 + 1));
        bytes memory excessValueMetadata = abi.encodePacked(
            uint256(2**255 + 1)
        );

        l1Mailbox.updateLatestDispatchedId(messageId);
        vm.expectRevert("OPStackHook: msgValue must less than 2 ** 255");
        opHook.postDispatch(excessValueMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_NotLastDispatchedMessage()
        public
    {
        deployAll();

        vm.selectFork(mainnetFork);

        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        opHook.postDispatch(testMetadata, encodedMessage);
    }

    /* ============ ISM.verifyMessageId ============ */

    function testFork_verifyMessageId() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        (uint240 nonce, uint16 verison) = Encoding.decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = Encoding.encodeVersionedNonce(
            nonce + 1,
            verison
        );

        bytes32 versionedHash = Hashing.hashCrossDomainMessageV1(
            versionedNonce,
            address(opHook),
            address(opISM),
            0,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS)
        );

        vm.expectEmit(true, false, false, false, address(opISM));
        emit ReceivedMessage(messageId);

        vm.expectEmit(true, false, false, false, L2_MESSENGER_ADDRESS);
        emit RelayedMessage(versionedHash);

        l2Messenger.relayMessage(
            versionedNonce,
            address(opHook),
            address(opISM),
            0,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        assertTrue(opISM.verifiedMessages(messageId).isBitSet(255));
        vm.stopPrank();
    }

    function testFork_verifyMessageId_RevertWhen_NotAuthorized() public {
        deployAll();

        vm.selectFork(optimismFork);

        // needs to be called by the cannonical messenger on Optimism
        vm.expectRevert(NotCrossChainCall.selector);
        opISM.verifyMessageId(messageId);

        // set the xDomainMessageSender storage slot as alice
        bytes32 key = bytes32(uint256(204));
        bytes32 value = TypeCasts.addressToBytes32(alice);
        vm.store(address(l2Messenger), key, value);

        vm.startPrank(L2_MESSENGER_ADDRESS);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        opISM.verifyMessageId(messageId);
    }

    /* ============ ISM.verify ============ */

    function testFork_verify() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        (uint240 nonce, uint16 verison) = Encoding.decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = Encoding.encodeVersionedNonce(
            nonce + 1,
            verison
        );

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            versionedNonce,
            address(opHook),
            address(opISM),
            0,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    /// forge-config: default.fuzz.runs = 10
    function testFork_verify_WithValue(uint256 _msgValue) public {
        _msgValue = bound(_msgValue, 0, 2**254);
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        (uint240 nonce, uint16 verison) = Encoding.decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = Encoding.encodeVersionedNonce(
            nonce + 1,
            verison
        );

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage{value: _msgValue}(
            versionedNonce,
            address(opHook),
            address(opISM),
            _msgValue,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        assertEq(address(opISM).balance, 0);
        assertEq(address(testRecipient).balance, _msgValue);
    }

    // sending over invalid message
    function testFork_verify_RevertWhen_HyperlaneInvalidMessage() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        (uint240 nonce, uint16 verison) = Encoding.decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = Encoding.encodeVersionedNonce(
            nonce + 1,
            verison
        );

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            versionedNonce,
            address(opHook),
            address(opISM),
            0,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        bytes memory invalidMessage = MessageUtils.formatMessage(
            VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(this)), // wrong recipient
            testMessage
        );
        bool verified = opISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    // invalid messageID in postDispatch
    function testFork_verify_RevertWhen_InvalidOptimismMessageID() public {
        deployAll();
        vm.selectFork(optimismFork);

        bytes memory invalidMessage = MessageUtils.formatMessage(
            VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            testMessage
        );
        bytes32 _messageId = Message.id(invalidMessage);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (_messageId)
        );

        (uint240 nonce, uint16 verison) = Encoding.decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = Encoding.encodeVersionedNonce(
            nonce + 1,
            verison
        );

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            versionedNonce,
            address(opHook),
            address(opISM),
            0,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                VERSION,
                uint32(0),
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                OPTIMISM_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }
}
