// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {OptimismISM} from "../../contracts/isms/hook/OptimismISM.sol";
import {OptimismMessageHook} from "../../contracts/hooks/OptimismMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {NotCrossChainCall} from "../../contracts/isms/hook/crossChainEnabled/errors.sol";

import {Lib_CrossDomainUtils} from "@eth-optimism/contracts/libraries/bridge/Lib_CrossDomainUtils.sol";
import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {ICanonicalTransactionChain} from "@eth-optimism/contracts/L1/rollup/ICanonicalTransactionChain.sol";
import {L2CrossDomainMessenger} from "@eth-optimism/contracts-bedrock/contracts/L2/L2CrossDomainMessenger.sol";
import {Encoding} from "@eth-optimism/contracts-bedrock/contracts/libraries/Encoding.sol";
import {Hashing} from "@eth-optimism/contracts-bedrock/contracts/libraries/Hashing.sol";

contract OptimismISMTest is Test {
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

    address internal alice = address(0x1);

    ICrossDomainMessenger internal l1Messenger;
    L2CrossDomainMessenger internal l2Messenger;
    OptimismISM internal opISM;
    OptimismMessageHook internal opHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

    bytes encodedMessage = _encodeTestMessage(0, address(testRecipient));
    bytes32 messageId = Message.id(encodedMessage);

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

    event ReceivedMessage(bytes32 indexed sender, bytes32 indexed messageId);

    function setUp() public {
        // block numbers to fork from, chain data is cached to ../../forge-cache/
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 17_586_909);
        optimismFork = vm.createFork(vm.rpcUrl("optimism"), 106_233_774);

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployOptimismHook() public {
        vm.selectFork(mainnetFork);

        l1Messenger = ICrossDomainMessenger(L1_MESSENGER_ADDRESS);

        opHook = new OptimismMessageHook(
            OPTIMISM_DOMAIN,
            L1_MESSENGER_ADDRESS,
            address(opISM)
        );

        vm.makePersistent(address(opHook));
    }

    function deployOptimismISM() public {
        vm.selectFork(optimismFork);

        l2Messenger = L2CrossDomainMessenger(L2_MESSENGER_ADDRESS);
        opISM = new OptimismISM(L2_MESSENGER_ADDRESS);

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOptimismISM();
        deployOptimismHook();

        vm.selectFork(optimismFork);

        opISM.setOptimismHook(address(opHook));
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

    function testFork_postDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.verifyMessageId,
            (address(this).addressToBytes32(), messageId)
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

        opHook.postDispatch(OPTIMISM_DOMAIN, messageId);
    }

    function testFork_postDispatch_RevertWhen_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        vm.expectRevert("OptimismHook: invalid destination domain");
        opHook.postDispatch(11, messageId);
    }

    /* ============ ISM.verifyMessageId ============ */

    function testFork_verifyMessageId() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.verifyMessageId,
            (address(this).addressToBytes32(), messageId)
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
        emit ReceivedMessage(address(this).addressToBytes32(), messageId);

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

        assertTrue(
            opISM.verifiedMessageIds(
                messageId,
                address(this).addressToBytes32()
            )
        );

        vm.stopPrank();
    }

    // will get included in https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2410
    // function testverifyMessageId_WithValue() public {
    //     // this would fail
    //     deployAll();

    //     vm.selectFork(optimismFork);

    //     bytes memory encodedHookData = abi.encodeCall(
    //         OptimismISM.verifyMessageId,
    //         (address(this), messageId)
    //     );

    //     (uint240 nonce, uint16 verison) =
    //         Encoding.decodeVersionedNonce(l2Messenger.messageNonce());
    //     uint256 versionedNonce = Encoding.encodeVersionedNonce(nonce + 1, verison);

    //     vm.startPrank(
    //         AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS)
    //     );

    //     l2Messenger.relayMessage{value: 1e18} (
    //         versionedNonce,
    //         address(opHook),
    //         address(opISM),
    //         1e18,
    //         DEFAULT_GAS_LIMIT,
    //         encodedHookData
    //     );

    //     assertEq(opISM.verifiedMessageIds(messageId, address(this)), true);
    //     assertEq(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS), 0);
    //     assertEq(address(this).balance, 1e18);

    //     vm.stopPrank();
    // }

    function testFork_verifyMessageId_RevertWhen_NotAuthorized() public {
        deployAll();

        vm.selectFork(optimismFork);

        // needs to be called by the cannonical messenger on Optimism
        vm.expectRevert(NotCrossChainCall.selector);
        opISM.verifyMessageId(address(opHook).addressToBytes32(), messageId);

        // set the xDomainMessageSender storage slot as alice
        bytes32 key = bytes32(uint256(204));
        bytes32 value = TypeCasts.addressToBytes32(alice);
        vm.store(address(l2Messenger), key, value);

        vm.startPrank(L2_MESSENGER_ADDRESS);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert("OptimismISM: sender is not the hook");
        opISM.verifyMessageId(address(opHook).addressToBytes32(), messageId);
    }

    /* ============ ISM.verify ============ */

    function testFork_verify() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.verifyMessageId,
            (address(this).addressToBytes32(), messageId)
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
            OptimismISM.verifyMessageId,
            (address(this).addressToBytes32(), messageId)
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
            OptimismISM.verifyMessageId,
            (address(this).addressToBytes32(), _messageId)
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

    function testFork_verify_RevertWhen_InvalidSender() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.verifyMessageId,
            (alice.addressToBytes32(), messageId)
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
