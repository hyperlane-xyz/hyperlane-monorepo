// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {ArbitrumISM} from "../../contracts/isms/native/ArbitrumISM.sol";
import {ArbitrumMessageHook} from "../../contracts/hooks/ArbitrumMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {Bytes32AddressLib} from "solmate/src/utils/Bytes32AddressLib.sol";

import {IInbox} from "@arbitrum/nitro-contracts/src/bridge/IInbox.sol";

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

    IInbox internal arbitrumInbox;
    ArbitrumISM internal arbitrumISM;
    ArbitrumMessageHook internal arbitrumHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant ARBITRUM_DOMAIN = 42161;

    event ArbitrumMessagePublished(
        address indexed target,
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
        arbitrumHook = new ArbitrumMessageHook(ARBITRUM_DOMAIN, arbitrumInbox);

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

        arbitrumISM = new ArbitrumISM(arbitrumHook);

        vm.makePersistent(address(arbitrumISM));
    }

    function deployAll() public {
        deployEthMailbox();
        deployArbitrumISM();
        deployArbMailbox();

        vm.selectFork(mainnetFork);
        arbitrumHook.setArbitrumISM(address(arbitrumISM));
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
            (messageId, address(this))
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

        // TODO: need approximate emits for submission fees abi-encoded
        vm.expectEmit(false, false, false, false, INBOX);
        emit InboxMessageDelivered(0, encodedMessageData);

        vm.expectEmit(true, true, true, false, address(arbitrumHook));
        emit ArbitrumMessagePublished(
            address(arbitrumISM),
            address(this),
            messageId,
            1e13
        );

        arbitrumHook.postDispatch(ARBITRUM_DOMAIN, messageId);
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

    function testDispatch_ISMNotSet() public {
        deployEthMailbox();
        deployArbitrumISM();

        vm.selectFork(mainnetFork);

        vm.expectRevert("ArbitrumHook: ArbitrumISM not set");

        arbitrumHook.postDispatch(ARBITRUM_DOMAIN, bytes32(0));
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
