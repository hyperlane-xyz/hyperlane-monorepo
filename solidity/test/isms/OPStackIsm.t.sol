// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {OPStackIsm} from "../../contracts/isms/hook/OPStackIsm.sol";
import {DefaultHook} from "../../contracts/hooks/DefaultHook.sol";
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
    using TypeCasts for address;

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

    address payable internal alice = payable(address(0x1));

    Mailbox internal l1Mailbox;
    DefaultHook internal defaultHook;
    ICrossDomainMessenger internal l1Messenger;
    L2CrossDomainMessenger internal l2Messenger;
    OPStackIsm internal opISM;
    OPStackHook internal opHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

    bytes internal encodedMessage =
        _encodeTestMessage(0, address(testRecipient));
    bytes32 internal messageId = Message.id(encodedMessage);

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
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployOPStackHook() public {
        vm.selectFork(mainnetFork);

        l1Mailbox = new Mailbox(MAINNET_DOMAIN, address(this));
        l1Messenger = ICrossDomainMessenger(L1_MESSENGER_ADDRESS);

        defaultHook = new DefaultHook(address(l1Mailbox), address(this));
        l1Mailbox.setDefaultHook(address(defaultHook));
        opHook = new OPStackHook(
            address(l1Mailbox),
            OPTIMISM_DOMAIN,
            address(opISM),
            L1_MESSENGER_ADDRESS
        );
        defaultHook.updateDefaultHook();

        // setting hooks for each domain for DRH
        uint32[] memory domains = new uint32[](1);
        domains[0] = OPTIMISM_DOMAIN;
        address[] memory hooks = new address[](1);
        hooks[0] = address(0x1);
        defaultHook.setHooks(domains, hooks);

        vm.makePersistent(address(opHook));
        vm.makePersistent(address(l1Mailbox));
    }

    function deployOPStackIsm() public {
        vm.selectFork(optimismFork);

        l2Messenger = L2CrossDomainMessenger(L2_MESSENGER_ADDRESS);
        opISM = new OPStackIsm(L2_MESSENGER_ADDRESS);

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOPStackIsm();
        deployOPStackHook();

        vm.selectFork(optimismFork);

        opISM.setAuthorizedHook(address(opHook));
        // for sending value
        vm.deal(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS),
            1e18
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    // custom from mailbox
    function testFork_postDispatch_customDefaultHook() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );

        uint40 nonce = ICanonicalTransactionChain(L1_CANNONICAL_CHAIN)
            .getQueueLength();

        vm.expectEmit(true, true, true, false, L1_MESSENGER_ADDRESS);
        emit SentMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nonce,
            DEFAULT_GAS_LIMIT
        );

        // opHook.postDispatch(OPTIMISM_DOMAIN, messageId);
        l1Mailbox.dispatch{value: 2 ether}(
            OPTIMISM_DOMAIN,
            address(testRecipient).addressToBytes32(),
            testMessage,
            opHook,
            abi.encode(1 ether)
        );
    }

    function testFork_postDispatch_customFromDefaultHook() public {
        deployAll();

        address[] memory customHooks = new address[](1);
        customHooks[0] = address(opHook);

        vm.selectFork(mainnetFork);
        defaultHook.configCustomHook(
            0,
            OPTIMISM_DOMAIN,
            address(testRecipient).addressToBytes32(),
            customHooks
        );

        bytes memory hookMetadata = abi.encodePacked(
            uint8(69),
            uint256(1 ether)
        );

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.verifyMessageId,
            (messageId)
        );
        uint40 nonce = ICanonicalTransactionChain(L1_CANNONICAL_CHAIN)
            .getQueueLength();

        vm.expectEmit(true, true, true, false, L1_MESSENGER_ADDRESS);
        emit SentMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nonce,
            DEFAULT_GAS_LIMIT
        );

        l1Mailbox.dispatch{value: 2 ether}(
            OPTIMISM_DOMAIN,
            address(testRecipient).addressToBytes32(),
            testMessage,
            hookMetadata
        );
    }

    // test if out-of-date default hook is used

    // test if igp payment made for custom config omission

    // test if igp payment made for custom config inclusion

    // when you set the destination to 11 instead of 10 as in config
    function testFork_postDispatch_RevertWhen_InvalidHookConfigured() public {
        deployAll();

        vm.selectFork(mainnetFork);
        bytes memory hookMetadata = abi.encodePacked(
            uint8(69),
            uint256(1 ether)
        );

        vm.expectRevert("DefaultHook: no hook specified");
        l1Mailbox.dispatch{value: 2 ether}(
            11,
            address(testRecipient).addressToBytes32(),
            testMessage,
            hookMetadata
        );
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

        vm.expectEmit(true, true, false, false, address(opISM));
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

        assertTrue(opISM.verifiedMessageIds(messageId));

        vm.stopPrank();
    }

    // will get included in https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2410
    function testverifyMessageId_WithValue() public {
        // this would fail
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            OPStackIsm.verifyMessageId,
            (messageId, alice)
        );

        (uint240 nonce, uint16 verison) = Encoding.decodeVersionedNonce(
            l2Messenger.messageNonce()
        );
        uint256 versionedNonce = Encoding.encodeVersionedNonce(
            nonce + 1,
            verison
        );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS)
        );

        uint256 priorBal = alice.balance;

        l2Messenger.relayMessage{value: 1e18}(
            versionedNonce,
            address(opHook),
            address(opISM),
            1e18,
            DEFAULT_GAS_LIMIT,
            encodedHookData
        );

        assertTrue(opISM.verifiedMessageIds(messageId));
        assertEq(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS).balance,
            0
        );
        assertEq(alice.balance - priorBal, 1e18);

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

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = opISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    // invalid messageID in postDispatch
    function testFork_verify_RevertWhen_InvalidOptimismMessageID() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
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

    function _encodeTestMessage(uint32 _msgCount, address _receipient)
        internal
        view
        returns (bytes memory)
    {
        return
            abi.encodePacked(
                VERSION,
                _msgCount,
                MAINNET_DOMAIN,
                TypeCasts.addressToBytes32(address(this)),
                OPTIMISM_DOMAIN,
                TypeCasts.addressToBytes32(_receipient),
                testMessage
            );
    }
}
