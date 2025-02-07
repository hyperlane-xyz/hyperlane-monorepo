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
import {PolygonPosIsm} from "../../contracts/isms/hook/PolygonPosIsm.sol";
import {PolygonPosHook} from "../../contracts/hooks/PolygonPosHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {NotCrossChainCall} from "@openzeppelin/contracts/crosschain/errors.sol";

interface IStateSender {
    function counter() external view returns (uint256);
}

interface FxChild {
    function onStateReceive(uint256 stateId, bytes calldata data) external;
}

contract PolygonPosIsmTest is Test {
    using LibBit for uint256;
    using TypeCasts for address;
    using MessageUtils for bytes;

    uint256 internal mainnetFork;
    uint256 internal polygonPosFork;

    address internal constant POLYGON_CROSSCHAIN_SYSTEM_ADDR =
        0x0000000000000000000000000000000000001001;

    address internal constant MUMBAI_FX_CHILD =
        0xCf73231F28B7331BBe3124B907840A94851f9f11;
    address internal constant GOERLI_CHECKPOINT_MANAGER =
        0x2890bA17EfE978480615e330ecB65333b880928e;
    address internal constant GOERLI_FX_ROOT =
        0x3d1d3E34f7fB6D26245E6640E1c50710eFFf15bA;

    address internal constant MAINNET_FX_CHILD =
        0x8397259c983751DAf40400790063935a11afa28a;
    address internal constant MAINNET_CHECKPOINT_MANAGER =
        0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287;
    address internal constant MAINNET_FX_ROOT =
        0xfe5e5D361b2ad62c541bAb87C45a0B9B018389a2;
    address internal constant MAINNET_STATE_SENDER =
        0x28e4F3a7f651294B9564800b2D01f35189A5bFbE;

    uint8 internal constant POLYGON_POS_VERSION = 0;
    uint8 internal constant HYPERLANE_VERSION = 1;

    TestMailbox internal l1Mailbox;
    PolygonPosIsm internal polygonPosISM;
    PolygonPosHook internal polygonPosHook;
    FxChild internal fxChild;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));

    bytes internal encodedMessage;
    bytes32 internal messageId;

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant POLYGON_POS_DOMAIN = 137;

    event StateSynced(
        uint256 indexed id,
        address indexed contractAddress,
        bytes data
    );

    event ReceivedMessage(bytes32 indexed messageId, uint256 msgValue);

    function setUp() public {
        // block numbers to fork from, chain data is cached to ../../forge-cache/
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"), 18_718_401);
        polygonPosFork = vm.createFork(vm.rpcUrl("polygon"), 50_760_479);

        testRecipient = new TestRecipient();

        encodedMessage = _encodeTestMessage();
        messageId = Message.id(encodedMessage);
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployPolygonPosHook() public {
        vm.selectFork(mainnetFork);

        l1Mailbox = new TestMailbox(MAINNET_DOMAIN);

        polygonPosHook = new PolygonPosHook(
            address(l1Mailbox),
            POLYGON_POS_DOMAIN,
            TypeCasts.addressToBytes32(address(polygonPosISM)),
            MAINNET_CHECKPOINT_MANAGER,
            MAINNET_FX_ROOT
        );

        polygonPosHook.setFxChildTunnel(address(polygonPosISM));

        vm.makePersistent(address(polygonPosHook));
    }

    function deployPolygonPosIsm() public {
        vm.selectFork(polygonPosFork);

        fxChild = FxChild(MAINNET_FX_CHILD);
        polygonPosISM = new PolygonPosIsm(MAINNET_FX_CHILD);

        vm.makePersistent(address(polygonPosISM));
    }

    function deployAll() public {
        deployPolygonPosIsm();
        deployPolygonPosHook();

        vm.selectFork(polygonPosFork);

        polygonPosISM.setAuthorizedHook(
            TypeCasts.addressToBytes32(address(polygonPosHook))
        );
    }

    ///////////////////////////////////////////////////////////////////
    ///                         FORK TESTS                          ///
    ///////////////////////////////////////////////////////////////////

    /* ============ hook.quoteDispatch ============ */

    function testFork_quoteDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        assertEq(polygonPosHook.quoteDispatch(testMetadata, encodedMessage), 0);
    }

    /* ============ hook.postDispatch ============ */

    function testFork_postDispatch() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (messageId, 0)
        );

        l1Mailbox.updateLatestDispatchedId(messageId);

        IStateSender stateSender = IStateSender(MAINNET_STATE_SENDER);

        vm.expectEmit(true, false, false, true);
        emit StateSynced(
            (stateSender.counter() + 1),
            MAINNET_FX_CHILD,
            abi.encode(
                TypeCasts.addressToBytes32(address(polygonPosHook)),
                TypeCasts.addressToBytes32(address(polygonPosISM)),
                encodedHookData
            )
        );
        polygonPosHook.postDispatch(testMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes memory message = MessageUtils.formatMessage(
            POLYGON_POS_VERSION,
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
        polygonPosHook.postDispatch(testMetadata, message);
    }

    function testFork_postDispatch_RevertWhen_TooMuchValue() public {
        deployAll();

        vm.selectFork(mainnetFork);

        // assign any value should revert
        vm.deal(address(this), uint256(2 ** 255));
        bytes memory excessValueMetadata = StandardHookMetadata
            .overrideMsgValue(uint256(2 ** 255));

        l1Mailbox.updateLatestDispatchedId(messageId);
        vm.expectRevert(
            "AbstractMessageIdAuthHook: msgValue must be less than 2 ** 255"
        );
        polygonPosHook.postDispatch(excessValueMetadata, encodedMessage);
    }

    function testFork_postDispatch_RevertWhen_NotLastDispatchedMessage()
        public
    {
        deployAll();

        vm.selectFork(mainnetFork);

        vm.expectRevert(
            "AbstractMessageIdAuthHook: message not latest dispatched"
        );
        polygonPosHook.postDispatch(testMetadata, encodedMessage);
    }

    /* ============ ISM.preVerifyMessage ============ */

    function testFork_preVerifyMessage() public {
        deployAll();

        vm.selectFork(polygonPosFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (messageId, 0)
        );

        vm.startPrank(POLYGON_CROSSCHAIN_SYSTEM_ADDR);

        vm.expectEmit(true, false, false, false, address(polygonPosISM));
        emit ReceivedMessage(messageId, 0);
        // FIX: expect other events

        fxChild.onStateReceive(
            0,
            abi.encode(
                TypeCasts.addressToBytes32(address(polygonPosHook)),
                TypeCasts.addressToBytes32(address(polygonPosISM)),
                encodedHookData
            )
        );

        assertTrue(polygonPosISM.verifiedMessages(messageId).isBitSet(255));
        vm.stopPrank();
    }

    function testFork_preVerifyMessage_RevertWhen_NotAuthorized() public {
        deployAll();

        vm.selectFork(polygonPosFork);

        // needs to be called by the fxchild on Polygon
        vm.expectRevert(NotCrossChainCall.selector);
        polygonPosISM.preVerifyMessage(messageId, 0);

        vm.startPrank(MAINNET_FX_CHILD);

        // needs to be called by the authorized hook contract on Ethereum
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        polygonPosISM.preVerifyMessage(messageId, 0);
    }

    /* ============ ISM.verify ============ */

    function testFork_verify() public {
        deployAll();

        vm.selectFork(polygonPosFork);

        orchestrateRelayMessage(messageId);

        bool verified = polygonPosISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);
    }

    // sending over invalid message
    function testFork_verify_RevertWhen_HyperlaneInvalidMessage() public {
        deployAll();

        orchestrateRelayMessage(messageId);

        bytes memory invalidMessage = MessageUtils.formatMessage(
            HYPERLANE_VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            POLYGON_POS_DOMAIN,
            TypeCasts.addressToBytes32(address(this)), // wrong recipient
            testMessage
        );
        bool verified = polygonPosISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);
    }

    // invalid messageID in postDispatch
    function testFork_verify_RevertWhen_InvalidPolygonPosMessageID() public {
        deployAll();
        vm.selectFork(polygonPosFork);

        bytes memory invalidMessage = MessageUtils.formatMessage(
            HYPERLANE_VERSION,
            uint8(0),
            MAINNET_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            POLYGON_POS_DOMAIN,
            TypeCasts.addressToBytes32(address(this)),
            testMessage
        );
        bytes32 _messageId = Message.id(invalidMessage);
        orchestrateRelayMessage(_messageId);

        bool verified = polygonPosISM.verify(new bytes(0), encodedMessage);
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
                POLYGON_POS_DOMAIN,
                TypeCasts.addressToBytes32(address(testRecipient)),
                testMessage
            );
    }

    function orchestrateRelayMessage(bytes32 _messageId) internal {
        vm.selectFork(polygonPosFork);

        bytes memory encodedHookData = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (_messageId, 0)
        );

        vm.prank(POLYGON_CROSSCHAIN_SYSTEM_ADDR);

        fxChild.onStateReceive(
            0,
            abi.encode(
                TypeCasts.addressToBytes32(address(polygonPosHook)),
                TypeCasts.addressToBytes32(address(polygonPosISM)),
                encodedHookData
            )
        );
    }
}
