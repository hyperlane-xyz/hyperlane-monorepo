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

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {OptimismIsm} from "../../contracts/isms/native/OptimismIsm.sol";
import {OptimismMessageHook} from "../../contracts/hooks/OptimismMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {Lib_CrossDomainUtils} from "@eth-optimism/contracts/libraries/bridge/Lib_CrossDomainUtils.sol";
import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {L2CrossDomainMessenger} from "@eth-optimism/contracts/L2/messaging/L2CrossDomainMessenger.sol";
import {ICanonicalTransactionChain} from "@eth-optimism/contracts/l1/rollup/ICanonicalTransactionChain.sol";

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
    address public constant L2_MESSENGER_ADDRESS =
        0x4200000000000000000000000000000000000007;

    uint8 public constant VERSION = 0;
    uint256 public constant DEFAULT_GAS_LIMIT = 1_920_000;

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

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        optimismFork = vm.createFork(vm.rpcUrl("optimism"));

        testRecipient = new TestRecipient();
    }

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

        opISM = new OptimismIsm();
        opMailbox.initialize(address(this), address(opISM));

        vm.makePersistent(address(opMailbox));
    }

    function deployOptimsimIsm() public {
        vm.selectFork(optimismFork);

        opISM = new OptimismIsm();
        opISM.setOptimismMessenger(
            L2CrossDomainMessenger(L2_MESSENGER_ADDRESS)
        );

        vm.makePersistent(address(opISM));
    }

    function deployAll() public {
        deployOptimsimIsm();
        deployEthMailbox();
        deployOpMailbox();
    }

    function testDispatch() public {
        deployOptimsimIsm();
        deployEthMailbox();

        vm.selectFork(mainnetFork);

        bytes memory encodedMessage = abi.encodePacked(
            VERSION,
            uint32(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            OPTIMISM_DOMAIN,
            TypeCasts.addressToBytes32(address(testRecipient)),
            testMessage
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

    function testReceiveFromHook() public {
        deployAll();

        vm.selectFork(optimismFork);
        assertEq(vm.activeFork(), optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
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

        // vm.expectEmit(true, false, false, false, L2_MESSENGER_ADDRESS);
        emit RelayedMessage(keccak256(xDomainCalldata));

        console.log("from test sender: ", l2Bridge.xDomainMessageSender());

        l2Bridge.relayMessage(
            address(opISM),
            address(opHook),
            encodedHookData,
            nextNonce
        );

        assertEq(opISM.receivedEmitters(_messageId), true);

        vm.stopPrank();
    }

    function testWrongChain() public {}

    function testVerify() public {
        deployAll();

        vm.selectFork(optimismFork);

        L2CrossDomainMessenger l2Bridge = L2CrossDomainMessenger(
            L2_MESSENGER_ADDRESS
        );

        bytes32 _messageId = keccak256(
            _encodeTestMessage(0, address(testRecipient))
        );

        bytes memory encodedHookData = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (_messageId, address(opHook))
        );
        uint256 nextNonce = l2Bridge.messageNonce() + 1;

        vm.prank(AddressAliasHelper.applyL1ToL2Alias(L1_MESSENGER_ADDRESS));
        // l2Bridge.relayMessage(
        //     address(opISM),
        //     address(opHook),
        //     encodedHookData,
        //     nextNonce
        // );
        // assertEq(opISM.receivedEmitters(_messageId), TypeCasts.addressToBytes32(address(opHook)));

        // bytes memory metadata = abi.encode(_messageId, address(opHook));
        // bool verified = opISM.verify(metadata, _encodeTestMessage(0, address(testRecipient)));
        // assertTrue(verified);
    }

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

    // set hook contract for the mailbox

    // postDispatch

    // check for correct message on the other chain
}
