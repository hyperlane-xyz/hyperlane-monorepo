// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {OptimismISM} from "../../contracts/isms/native/OptimismISM.sol";
import {OptimismMessageHook} from "../../contracts/hooks/OptimismMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {Lib_CrossDomainUtils} from "@eth-optimism/contracts/libraries/bridge/Lib_CrossDomainUtils.sol";
import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {ICanonicalTransactionChain} from "@eth-optimism/contracts/L1/rollup/ICanonicalTransactionChain.sol";
import {L2CrossDomainMessenger} from "@eth-optimism/contracts/L2/messaging/L2CrossDomainMessenger.sol";

contract OptimismISMTest is Test {
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
    L2CrossDomainMessenger l2Messenger;
    OptimismISM internal opISM;
    OptimismMessageHook internal opHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

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

    event ReceivedMessage(address indexed emitter, bytes32 indexed messageId);

    error NotCrossChainCall();

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        optimismFork = vm.createFork(vm.rpcUrl("optimism"));

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

    function deployOptimsimISM() public {
        vm.selectFork(optimismFork);

        l2Messenger = L2CrossDomainMessenger(L2_MESSENGER_ADDRESS);
        opISM = new OptimismISM(L2_MESSENGER_ADDRESS);

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOptimsimISM();
        deployOptimismHook();

        vm.selectFork(optimismFork);
        opISM.setOptimismHook(address(opHook));
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.postDispatch ============ */

    function testPostDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), messageId)
        );

        uint40 nonce = ICanonicalTransactionChain(L1_CANNONICAL_CHAIN)
            .getQueueLength();

        // console.log("another nonce: ", l1Messenger.messageNonce());

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

    function testPostDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert("OptimismHook: invalid destination domain");
        opHook.postDispatch(11, messageId);
    }

    /* ============ ISM.receiveFromHook ============ */

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes32 _messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Messenger.messageNonce() + 1;
        console.log("MessageNonce: ", l2Messenger.messageNonce());

        bytes memory xDomainCalldata = Lib_CrossDomainUtils
            .encodeXDomainCalldata(
                address(opISM),
                address(opHook),
                encodedHookData,
                139885
            );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS)
        );
        console.log(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));

        // vm.expectEmit(true, true, false, false, address(opISM));
        // emit ReceivedMessage(address(this), _messageId);

        // vm.expectEmit(true, false, false, false, L2_MESSENGER_ADDRESS);
        // emit RelayedMessage(Message.id(xDomainCalldata));

        l2Messenger.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        assertEq(opISM.receivedEmitters(_messageId, address(this)), true);

        vm.stopPrank();
    }

    function testReceiveFromHook_NotAuthorized() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        // needs to be called by the cannonical messenger on Optimism
        vm.expectRevert(NotCrossChainCall.selector);
        opISM.receiveFromHook(address(opHook), _messageId);

        // set the xDomainMessageSender storage slot as alice
        bytes32 key = bytes32(uint256(4));
        bytes32 value = TypeCasts.addressToBytes32(alice);
        vm.store(address(l2Messenger), key, value);

        vm.startPrank(L2_MESSENGER_ADDRESS);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert("OptimismISM: caller is not the owner");
        opISM.receiveFromHook(address(opHook), _messageId);
    }

    /* ============ ISM.verify ============ */

    function testVerify() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Messenger.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    function testVerify_InvalidMessage_Hyperlane() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Messenger.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = opISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    function testVerify_InvalidMessageID_Optimism() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bytes32 _messageId = Message.id(invalidMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (address(this), _messageId)
        );
        uint256 nextNonce = l2Messenger.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);
    }

    function testVerify_InvalidSender() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismISM.receiveFromHook,
            (alice, _messageId)
        );
        uint256 nextNonce = l2Messenger.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Messenger.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
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
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(_receipient),
            testMessage
        );
    }
}
