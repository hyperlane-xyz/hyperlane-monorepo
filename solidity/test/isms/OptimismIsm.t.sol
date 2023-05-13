// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import "forge-std/Test.sol";
import "forge-std/console.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {OptimismIsm} from "../../contracts/isms/native/OptimismIsm.sol";
import {OptimismMessageHook} from "../../contracts/hooks/OptimismMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {Lib_CrossDomainUtils} from "@eth-optimism/contracts/libraries/bridge/Lib_CrossDomainUtils.sol";
import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {ICanonicalTransactionChain} from "@eth-optimism/contracts/l1/rollup/ICanonicalTransactionChain.sol";
import {L2CrossDomainMessenger} from "@eth-optimism/contracts/L2/messaging/L2CrossDomainMessenger.sol";
import {Predeploys} from "@eth-optimism/contracts-bedrock/contracts/libraries/Predeploys.sol";

import {Bytes32AddressLib} from "solmate/src/utils/Bytes32AddressLib.sol";

contract OptimismIsmTest is Test {
    uint256 public mainnetFork;
    uint256 public optimismFork;

    Mailbox public ethMailbox;
    Mailbox public opMailbox;

    TestMultisigIsm public ism;

    address public constant L1_MESSENGER_ADDRESS =
        0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1;
    address public constant L1_CANNONICAL_CHAIN =
        0x5E4e65926BA27467555EB562121fac00D24E9dD2;

    uint8 public constant VERSION = 0;
    uint256 public constant DEFAULT_GAS_LIMIT = 1_920_000;

    address public alice = address(0x1);

    ICrossDomainMessenger public opNativeMessenger;
    OptimismIsm public opISM;
    OptimismMessageHook public opHook;

    TestRecipient public testRecipient;
    bytes public testMessage = abi.encodePacked("Hello from the other chain!");

    uint32 public constant MAINNET_DOMAIN = 1;
    uint32 public constant OPTIMISM_DOMAIN = 10;

    event OptimismMessagePublished(
        address indexed target,
        address indexed sender,
        bytes32 indexed messageId
    );

    event SentMessage(
        address indexed target,
        address sender,
        bytes message,
        uint256 messageNonce,
        uint256 gasLimit
    );

    event RelayedMessage(bytes32 indexed msgHash);

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        optimismFork = vm.createFork(vm.rpcUrl("optimism"));

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployEthMailbox() public {
        vm.selectFork(mainnetFork);

        ism = new TestMultisigIsm();

        opNativeMessenger = ICrossDomainMessenger(L1_MESSENGER_ADDRESS);
        opHook = new OptimismMessageHook(opNativeMessenger);

        opHook.setOptimismISM(address(opISM));

        ethMailbox = new Mailbox(MAINNET_DOMAIN);
        ethMailbox.initialize(address(this), address(ism));
        ethMailbox.setHook(address(opHook));

        vm.makePersistent(address(ethMailbox));
    }

    function deployOpMailbox() public {
        vm.selectFork(optimismFork);

        opMailbox = new Mailbox(OPTIMISM_DOMAIN);
        opMailbox.initialize(address(this), address(opISM));

        vm.makePersistent(address(opMailbox));
    }

    function deployOptimsimIsm() public {
        vm.selectFork(optimismFork);

        opISM = new OptimismIsm(
            L2CrossDomainMessenger(Predeploys.L2_CROSS_DOMAIN_MESSENGER)
        );

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOptimsimIsm();
        deployEthMailbox();
        deployOpMailbox();

        vm.selectFork(optimismFork);
        opISM.setOptimismHook(opHook);
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
            OptimismIsm.receiveFromHook,
            (messageId, address(opHook))
        );

        uint40 nonce = ICanonicalTransactionChain(L1_CANNONICAL_CHAIN)
            .getQueueLength();

        vm.expectEmit(true, true, true, true, L1_MESSENGER_ADDRESS);
        emit SentMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nonce,
            DEFAULT_GAS_LIMIT
        );

        vm.expectEmit(true, true, true, true, address(opHook));
        emit OptimismMessagePublished(
            address(opISM),
            address(opHook),
            messageId
        );

        ethMailbox.dispatch(
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
    }

    function testDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        vm.expectRevert("OptimismHook: destination must be Optimism");

        ethMailbox.dispatch(
            11,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
    }

    function testDispatch_ISMNotSet() public {
        deployOptimsimIsm();

        vm.selectFork(mainnetFork);

        ism = new TestMultisigIsm();

        opNativeMessenger = ICrossDomainMessenger(L1_MESSENGER_ADDRESS);
        opHook = new OptimismMessageHook(opNativeMessenger);

        ethMailbox = new Mailbox(MAINNET_DOMAIN);
        ethMailbox.initialize(address(this), address(ism));
        ethMailbox.setHook(address(opHook));

        vm.makePersistent(address(ethMailbox));

        vm.expectRevert("OptimismHook: OptimismIsm not set");
        ethMailbox.dispatch(
            10,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
        );
    }

    /* ============ ISM.receiveFromHook ============ */

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(optimismFork);
        assertEq(vm.activeFork(), optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            Predeploys.L2_CROSS_DOMAIN_MESSENGER
        );

        bytes32 _messageId = keccak256(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (_messageId, address(ethMailbox))
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        bytes memory xDomainCalldata = Lib_CrossDomainUtils
            .encodeXDomainCalldata(
                address(opISM),
                address(opHook),
                encodedHookData,
                nextNonce
            );

        vm.startPrank(
            AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS)
        );

        vm.expectEmit(true, true, false, false, address(opISM));
        emit ReceivedMessage(_messageId, address(ethMailbox));

        vm.expectEmit(
            true,
            false,
            false,
            false,
            Predeploys.L2_CROSS_DOMAIN_MESSENGER
        );
        emit RelayedMessage(keccak256(xDomainCalldata));

        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        assertEq(opISM.receivedEmitters(_messageId), true);

        vm.stopPrank();
    }

    function testReceiveFromHook_NotAuthorized() public {
        deployAll();

        vm.selectFork(optimismFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = keccak256(encodedMessage);

        // needs to be called by the cannonical messenger on Optimism
        vm.expectRevert("OptimismIsm: caller is not the messenger");
        opISM.receiveFromHook(_messageId, address(opHook));

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            Predeploys.L2_CROSS_DOMAIN_MESSENGER
        );

        // set the xDomainMessageSender storage slot as alice
        bytes32 key = bytes32(uint256(4));
        bytes32 value = TypeCasts.addressToBytes32(alice);
        vm.store(address(l2Bridge), key, value);

        vm.startPrank(Predeploys.L2_CROSS_DOMAIN_MESSENGER);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert("OptimismIsm: caller is not the owner");
        opISM.receiveFromHook(_messageId, address(opHook));
    }

    /* ============ ISM.verify ============ */

    function testVerify() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            Predeploys.L2_CROSS_DOMAIN_MESSENGER
        );

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = keccak256(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (_messageId, address(opHook))
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bool verified = opISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        bool verifiedTwice = opISM.verify(new bytes(0), encodedMessage);
        assertFalse(verifiedTwice);
    }

    function testVerify_InvalidMessage() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            Predeploys.L2_CROSS_DOMAIN_MESSENGER
        );

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 _messageId = keccak256(encodedMessage);

        bytes memory encodedHookData = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (_messageId, address(opHook))
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = opISM.verify(new bytes(0), invalidMessage);
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
