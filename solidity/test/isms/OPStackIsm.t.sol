// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {LibBit} from "../../contracts/libs/LibBit.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "./IsmTestUtils.sol";
import {OPStackIsm} from "../../contracts/isms/hook/OPStackIsm.sol";
import {OPStackHook} from "../../contracts/hooks/OPStackHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {NotCrossChainCall} from "@openzeppelin/contracts/crosschain/errors.sol";

import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger, IL2CrossDomainMessenger} from "../../contracts/interfaces/optimism/ICrossDomainMessenger.sol";

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

    uint8 internal constant OPTIMISM_VERSION = 0;
    uint8 internal constant HYPERLANE_VERSION = 1;
    uint256 internal constant DEFAULT_GAS_LIMIT = 1_920_000;

    address internal alice = address(0x1);

    ICrossDomainMessenger internal l1Messenger;
    IL2CrossDomainMessenger internal l2Messenger;
    TestMailbox internal l1Mailbox;
    OPStackIsm internal opISM;
    OPStackHook internal opHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata =
        StandardHookMetadata.formatMetadata(0, 0, address(this), "");

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
            TypeCasts.addressToBytes32(address(opISM)),
            L1_MESSENGER_ADDRESS
        );

        vm.makePersistent(address(opHook));
    }

    function deployOPStackIsm() public {
        vm.selectFork(optimismFork);

        l2Messenger = IL2CrossDomainMessenger(L2_MESSENGER_ADDRESS);
        opISM = new OPStackIsm(L2_MESSENGER_ADDRESS);

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOPStackIsm();
        deployOptimismHook();

        vm.selectFork(optimismFork);

        opISM.setAuthorizedHook(TypeCasts.addressToBytes32(address(opHook)));
        // for sending value
        vm.deal(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS),
            2**255
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.quoteDispatch ============ */

    function testFork_quoteDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        assertEq(opHook.quoteDispatch(testMetadata, encodedMessage), 0);
    }

    /* ============ hook.postDispatch ============ */

    function testFork_postDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        uint40 testNonce = 123;
        l1Mailbox.updateLatestDispatchedId(messageId);

        vm.expectEmit(true, true, true, false, L1_MESSENGER_ADDRESS);
        emit SentMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            testNonce,
            DEFAULT_GAS_LIMIT
        );
        opHook.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory message = MessageUtils.formatMessage(
            OPTIMISM_VERSION,
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
        bytes memory excessValueMetadata = StandardHookMetadata.formatMetadata(
            uint256(2**255 + 1),
            DEFAULT_GAS_LIMIT,
            address(this),
            ""
        );

        l1Mailbox.updateLatestDispatchedId(messageId);
        vm.expectRevert("OPStackHook: msgValue must be less than 2 ** 255");
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

        (uint240 nonce, uint16 version) = decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = encodeVersionedNonce(nonce + 1, version);

        bytes32 versionedHash = hashCrossDomainMessageV1(
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

        orchestrateRelayMessage(0, messageId);

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    /// forge-config: default.fuzz.runs = 10
    function testFork_verify_WithValue(uint256 _msgValue) public {
        _msgValue = bound(_msgValue, 0, 2**254);
        deployAll();

        orchestrateRelayMessage(_msgValue, messageId);

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        assertEq(address(opISM).balance, 0);
        assertEq(address(testRecipient).balance, _msgValue);
    }

    /// forge-config: default.fuzz.runs = 10
    function testFork_verify_valueAlreadyClaimed(uint256 _msgValue) public {
        _msgValue = bound(_msgValue, 0, 2**254);
        deployAll();

        orchestrateRelayMessage(_msgValue, messageId);

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        assertEq(address(opISM).balance, 0);
        assertEq(address(testRecipient).balance, _msgValue);

        // send more value to the ISM
        vm.deal(address(opISM), _msgValue);

        verified = opISM.verify(new bytes(0), encodedMessage);
        // verified still true
        assertTrue(verified);

        assertEq(address(opISM).balance, _msgValue);
        // value which was already sent
        assertEq(address(testRecipient).balance, _msgValue);
    }

    function testFork_verify_tooMuchValue() public {
        deployAll();

        uint256 _msgValue = 2**255 + 1;

        vm.expectEmit(false, false, false, false, address(l2Messenger));
        emit FailedRelayedMessage(messageId);
        orchestrateRelayMessage(_msgValue, messageId);

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);

        assertEq(address(opISM).balance, 0);
        assertEq(address(testRecipient).balance, 0);
    }

    // sending over invalid message
    function testFork_verify_RevertWhen_HyperlaneInvalidMessage() public {
        deployAll();

        orchestrateRelayMessage(0, messageId);

        bytes memory invalidMessage = MessageUtils.formatMessage(
            HYPERLANE_VERSION,
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
            HYPERLANE_VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            testMessage
        );
        bytes32 _messageId = Message.id(invalidMessage);
        orchestrateRelayMessage(0, _messageId);

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    /* ============ helper functions ============ */

    function _encodeTestMessage() internal view returns (bytes memory) {
        return
            MessageUtils.formatMessage(
                HYPERLANE_VERSION,
                uint32(0),
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                OPTIMISM_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    /// @dev from eth-optimism/contracts-bedrock/contracts/libraries/Hashing.sol
    /// @notice Hashes a cross domain message based on the V1 (current) encoding.
    /// @param _nonce    Message nonce.
    /// @param _sender   Address of the sender of the message.
    /// @param _target   Address of the target of the message.
    /// @param _value    ETH value to send to the target.
    /// @param _gasLimit Gas limit to use for the message.
    /// @param _data     Data to send with the message.
    /// @return Hashed cross domain message.
    function hashCrossDomainMessageV1(
        uint256 _nonce,
        address _sender,
        address _target,
        uint256 _value,
        uint256 _gasLimit,
        bytes memory _data
    ) internal pure returns (bytes32) {
        return
            keccak256(
                encodeCrossDomainMessageV1(
                    _nonce,
                    _sender,
                    _target,
                    _value,
                    _gasLimit,
                    _data
                )
            );
    }

    /// @dev from eth-optimism/contracts-bedrock/contracts/libraries/Encoding.sol
    /// @notice Encodes a cross domain message based on the V1 (current) encoding.
    /// @param _nonce    Message nonce.
    /// @param _sender   Address of the sender of the message.
    /// @param _target   Address of the target of the message.
    /// @param _value    ETH value to send to the target.
    /// @param _gasLimit Gas limit to use for the message.
    /// @param _data     Data to send with the message.
    /// @return Encoded cross domain message.
    function encodeCrossDomainMessageV1(
        uint256 _nonce,
        address _sender,
        address _target,
        uint256 _value,
        uint256 _gasLimit,
        bytes memory _data
    ) internal pure returns (bytes memory) {
        return
            abi.encodeWithSignature(
                "relayMessage(uint256,address,address,uint256,uint256,bytes)",
                _nonce,
                _sender,
                _target,
                _value,
                _gasLimit,
                _data
            );
    }

    /// @dev from eth-optimism/contracts-bedrock/contracts/libraries/Encoding.sol
    /// @notice Adds a version number into the first two bytes of a message nonce.
    /// @param _nonce   Message nonce to encode into.
    /// @param _version Version number to encode into the message nonce.
    /// @return Message nonce with version encoded into the first two bytes.
    function encodeVersionedNonce(uint240 _nonce, uint16 _version)
        internal
        pure
        returns (uint256)
    {
        uint256 nonce;
        assembly {
            nonce := or(shl(240, _version), _nonce)
        }
        return nonce;
    }

    /// @dev from eth-optimism/contracts-bedrock/contracts/libraries/Encoding.sol
    /// @notice Pulls the version out of a version-encoded nonce.
    /// @param _nonce Message nonce with version encoded into the first two bytes.
    /// @return Nonce without encoded version.
    /// @return Version of the message.
    function decodeVersionedNonce(uint256 _nonce)
        internal
        pure
        returns (uint240, uint16)
    {
        uint240 nonce;
        uint16 version;
        assembly {
            nonce := and(
                _nonce,
                0x0000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
            )
            version := shr(240, _nonce)
        }
        return (nonce, version);
    }

    function orchestrateRelayMessage(uint256 _msgValue, bytes32 _messageId)
        internal
    {
        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (_messageId)
        );

        (uint240 nonce, uint16 version) = decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = encodeVersionedNonce(nonce + 1, version);

        vm.deal(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS),
            2**256 - 1
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
    }
}
