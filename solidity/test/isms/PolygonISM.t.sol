// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {PolygonISM} from "../../contracts/isms/native/PolygonISM.sol";
import {PolygonMessageHook} from "../../contracts/hooks/PolygonMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

import {StateSender} from "./polygon/StateSender.sol";

contract PolygonISMTest is Test {
    uint256 internal mainnetFork;
    uint256 internal polygonFork;

    address internal constant CHECKPOINT_MANAGER =
        0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287;
    address internal constant FX_ROOT =
        0xfe5e5D361b2ad62c541bAb87C45a0B9B018389a2;
    address internal constant FX_CHILD =
        0x8397259c983751DAf40400790063935a11afa28a;
    address internal constant STATE_SYNCER =
        0x28e4F3a7f651294B9564800b2D01f35189A5bFbE;

    uint8 internal constant VERSION = 0;

    address internal alice = address(0x1);

    PolygonISM internal polygonISM;
    PolygonMessageHook internal polygonHook;

    TestRecipient internal testRecipient;
    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");

    uint32 internal constant MAINNET_DOMAIN = 1;
    uint32 internal constant POLYGON_DOMAIN = 137;

    event PolygonMessagePublished(
        address indexed sender,
        bytes32 indexed messageId
    );
    event StateSynced(
        uint256 indexed id,
        address indexed contractAddress,
        bytes data
    );

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        polygonFork = vm.createFork(vm.rpcUrl("polygon"));

        testRecipient = new TestRecipient();
    }

    ///////////////////////////////////////////////////////////////////
    ///                            SETUP                            ///
    ///////////////////////////////////////////////////////////////////

    function deployPolygonHook() public {
        vm.selectFork(mainnetFork);

        polygonHook = new PolygonMessageHook(
            POLYGON_DOMAIN,
            CHECKPOINT_MANAGER,
            FX_ROOT,
            address(polygonISM)
        );

        vm.makePersistent(address(polygonHook));
    }

    function deployPolyonISM() public {
        vm.selectFork(polygonFork);

        polygonISM = new PolygonISM(FX_CHILD);

        vm.makePersistent(address(polygonISM));
    }

    function deployAll() public {
        deployPolyonISM();
        deployPolygonHook();

        vm.selectFork(polygonFork);
        polygonISM.setPolygonHook(address(polygonHook));
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
        bytes32 messageId = Message.id(encodedMessage);

        bytes memory encodedHookData = abi.encode(address(this), messageId);
        bytes memory data = abi.encode(
            address(polygonHook),
            address(0),
            encodedHookData
        );

        uint256 counter = StateSender(STATE_SYNCER).counter() + 1;

        vm.expectEmit(true, true, true, true, address(STATE_SYNCER));
        emit StateSynced(counter, FX_CHILD, data);

        vm.expectEmit(true, true, true, true, address(polygonHook));
        emit PolygonMessagePublished(address(this), messageId);

        polygonHook.postDispatch(POLYGON_DOMAIN, messageId);
    }

    function testDispatch_ChainIDNotSupported() public {
        deployAll();

        vm.selectFork(mainnetFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );

        vm.expectRevert("PolygonHook: invalid destination domain");
        polygonHook.postDispatch(138, messageId);
    }

    /* ============ ISM.processMessageFromRoot ============ */

    function testProcessMessage() public {
        deployAll();

        vm.selectFork(polygonFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );
        bytes memory encodedHookData = abi.encode(address(this), messageId);

        vm.startPrank(FX_CHILD);

        vm.expectEmit(true, true, false, false, address(polygonISM));
        emit ReceivedMessage(messageId, address(this));

        polygonISM.processMessageFromRoot(
            1,
            address(polygonHook),
            encodedHookData
        );

        vm.stopPrank();
    }

    function testProcessMessage_NotAuhtoized() public {
        deployAll();

        vm.selectFork(polygonFork);

        bytes32 messageId = Message.id(
            _encodeTestMessage(0, address(testRecipient))
        );
        bytes memory encodedHookData = abi.encode(address(this), messageId);

        vm.expectRevert("FxBaseChildTunnel: INVALID_SENDER");
        polygonISM.processMessageFromRoot(
            1,
            address(polygonHook),
            encodedHookData
        );

        vm.startPrank(FX_CHILD);

        vm.expectRevert("FxBaseChildTunnel: INVALID_SENDER_FROM_ROOT");
        polygonISM.processMessageFromRoot(1, address(this), encodedHookData);

        vm.stopPrank();
    }

    /* ============ ISM.verify ============ */

    function testVerify() public {
        deployAll();

        vm.selectFork(polygonFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);
        bytes memory encodedHookData = abi.encode(address(this), messageId);

        vm.startPrank(FX_CHILD);

        vm.expectEmit(true, true, false, false, address(polygonISM));
        emit ReceivedMessage(messageId, address(this));

        polygonISM.processMessageFromRoot(
            1,
            address(polygonHook),
            encodedHookData
        );

        bool verified = polygonISM.verify(new bytes(0), encodedMessage);
        assertTrue(verified);

        vm.stopPrank();
    }

    function testVerify_InvalidMessage_Hyperlane() public {
        deployAll();

        vm.selectFork(polygonFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);
        bytes memory encodedHookData = abi.encode(address(this), messageId);

        vm.startPrank(FX_CHILD);

        polygonISM.processMessageFromRoot(
            1,
            address(polygonHook),
            encodedHookData
        );

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bool verified = polygonISM.verify(new bytes(0), invalidMessage);
        assertFalse(verified);

        vm.stopPrank();
    }

    function testVerify_InvalidMessageId_Polygon() public {
        deployAll();

        vm.selectFork(polygonFork);

        bytes memory invalidMessage = _encodeTestMessage(0, address(this));
        bytes32 messageId = Message.id(invalidMessage);
        bytes memory encodedHookData = abi.encode(address(this), messageId);

        vm.startPrank(FX_CHILD);

        polygonISM.processMessageFromRoot(
            1,
            address(polygonHook),
            encodedHookData
        );

        bool verified = polygonISM.verify(new bytes(0), encodedHookData);
        assertFalse(verified);

        vm.stopPrank();
    }

    function testVerify_InvalidSender() public {
        deployAll();

        vm.selectFork(polygonFork);

        bytes memory encodedMessage = _encodeTestMessage(
            0,
            address(testRecipient)
        );
        bytes32 messageId = Message.id(encodedMessage);
        bytes memory encodedHookData = abi.encode(alice, messageId);

        vm.startPrank(FX_CHILD);

        polygonISM.processMessageFromRoot(
            1,
            address(polygonHook),
            encodedHookData
        );

        bool verified = polygonISM.verify(new bytes(0), encodedMessage);
        assertFalse(verified);

        vm.stopPrank();
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
            POLYGON_DOMAIN,
            TypeCasts.addressToBytes32(_receipient),
            testMessage
        );
    }
}
