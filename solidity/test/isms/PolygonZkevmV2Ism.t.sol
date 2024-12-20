// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {PolygonZkevmV2Hook} from "../../contracts/hooks/PolygonZkevmV2Hook.sol";
import {PolygonZkevmV2Ism} from "../../contracts/isms/hook/PolygonZkevmV2Ism.sol";
import {MockPolygonZkEVMBridgeV2} from "../../contracts/mock/MockPolygonZkEVMBridgeV2.sol";
import {MockInterchainGasPaymaster} from "../../contracts/mock/MockInterchainGasPaymaster.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";

contract PolygonZkevmV2IsmAndHookTest is Test {
    using TypeCasts for bytes32;
    using TypeCasts for address;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    TestMailbox public mailbox;
    PolygonZkevmV2Ism public ism;
    PolygonZkevmV2Hook public hook;
    MockPolygonZkEVMBridgeV2 public zkEvmBridge;
    MockInterchainGasPaymaster public interchainGasPaymaster;
    TestRecipient public testRecipient;

    uint32 public constant ORIGIN_DOMAIN = 1;
    uint32 public constant DESTINATION_DOMAIN = 2;
    uint32 public constant ZKEVM_BRIDGE_DESTINATION_NET_ID = 1;
    string[] public offchainUrls = ["https://example.com"];

    bytes public testMessage = abi.encodePacked("Hello from the other chain!");
    bytes public testMetadata;

    function setUp() public {
        mailbox = new TestMailbox(ORIGIN_DOMAIN);
        zkEvmBridge = new MockPolygonZkEVMBridgeV2();
        interchainGasPaymaster = new MockInterchainGasPaymaster();

        ism = new PolygonZkevmV2Ism(
            address(zkEvmBridge),
            ZKEVM_BRIDGE_DESTINATION_NET_ID,
            address(mailbox),
            offchainUrls
        );

        hook = new PolygonZkevmV2Hook(
            address(mailbox),
            DESTINATION_DOMAIN,
            address(ism),
            address(zkEvmBridge),
            ZKEVM_BRIDGE_DESTINATION_NET_ID,
            address(interchainGasPaymaster)
        );

        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
        testRecipient = new TestRecipient();

        zkEvmBridge.setIsm(ism);
        zkEvmBridge.setReturnData(abi.encodePacked(testMessage.id()));

        testMetadata = StandardHookMetadata.overrideMsgValue(0);
    }

    function test_constructor() public view {
        assertEq(address(hook.mailbox()), address(mailbox));
        assertEq(hook.destinationDomain(), DESTINATION_DOMAIN);
        assertEq(hook.ism(), address(ism));
        assertEq(address(hook.zkEvmBridge()), address(zkEvmBridge));
        assertEq(
            hook.zkEvmBridgeDestinationNetId(),
            ZKEVM_BRIDGE_DESTINATION_NET_ID
        );
        assertEq(
            address(hook.interchainGasPaymaster()),
            address(interchainGasPaymaster)
        );
    }

    function test_supportsMetadata() public view {
        assertTrue(hook.supportsMetadata(testMetadata));
    }

    function test_quoteDispatch() public {
        uint256 gasPayment = 1 ether;
        interchainGasPaymaster.setGasPayment(gasPayment);

        uint256 quote = hook.quoteDispatch(testMetadata, testMessage);
        assertEq(quote, gasPayment);
    }

    function test_postDispatch() public {
        uint256 gasPayment = 1 ether;
        uint256 msgValue = 1.5 ether;
        interchainGasPaymaster.setGasPayment(gasPayment);

        vm.deal(address(this), msgValue);
        testMetadata = StandardHookMetadata.overrideMsgValue(
            msgValue - gasPayment
        );

        vm.expectCall(
            address(interchainGasPaymaster),
            gasPayment,
            abi.encodeCall(
                interchainGasPaymaster.payForGas,
                (testMessage.id(), 0, 150000, address(this))
            )
        );

        vm.expectCall(
            address(zkEvmBridge),
            msgValue - gasPayment,
            abi.encodeCall(
                zkEvmBridge.bridgeMessage,
                (
                    ZKEVM_BRIDGE_DESTINATION_NET_ID,
                    address(ism),
                    true,
                    abi.encode(testMessage.id())
                )
            )
        );

        hook.postDispatch{value: msgValue}(testMetadata, testMessage);
    }

    function test_postDispatch_exactGasPayment() public {
        uint256 gasPayment = 1 ether;
        interchainGasPaymaster.setGasPayment(gasPayment);

        vm.deal(address(this), gasPayment);
        testMetadata = StandardHookMetadata.overrideMsgValue(0);

        vm.expectCall(
            address(interchainGasPaymaster),
            gasPayment,
            abi.encodeCall(
                interchainGasPaymaster.payForGas,
                (testMessage.id(), 0, 150000, address(this))
            )
        );

        vm.expectCall(
            address(zkEvmBridge),
            0,
            abi.encodeCall(
                zkEvmBridge.bridgeMessage,
                (
                    ZKEVM_BRIDGE_DESTINATION_NET_ID,
                    address(ism),
                    true,
                    abi.encode(testMessage.id())
                )
            )
        );

        hook.postDispatch{value: gasPayment}(testMetadata, testMessage);
    }

    function test_postDispatch_excessGasPayment() public {
        uint256 gasPayment = 1 ether;
        uint256 excessPayment = 1.5 ether;
        interchainGasPaymaster.setGasPayment(gasPayment);

        vm.deal(address(this), excessPayment);
        testMetadata = StandardHookMetadata.overrideMsgValue(0);

        vm.expectCall(
            address(interchainGasPaymaster),
            gasPayment,
            abi.encodeCall(
                interchainGasPaymaster.payForGas,
                (testMessage.id(), 0, 150000, address(this))
            )
        );

        vm.expectCall(
            address(zkEvmBridge),
            excessPayment - gasPayment,
            abi.encodeCall(
                zkEvmBridge.bridgeMessage,
                (
                    ZKEVM_BRIDGE_DESTINATION_NET_ID,
                    address(ism),
                    true,
                    abi.encode(testMessage.id())
                )
            )
        );

        hook.postDispatch{value: excessPayment}(testMetadata, testMessage);
    }

    function test_postDispatch_revertInsufficientGas() public {
        uint256 gasPayment = 1 ether;
        uint256 insufficientValue = 0.5 ether;
        interchainGasPaymaster.setGasPayment(gasPayment);

        vm.deal(address(this), insufficientValue);
        testMetadata = StandardHookMetadata.overrideMsgValue(0);

        vm.expectRevert(
            "PolygonzkEVMv2Hook: msgValue must be more than required gas"
        );
        hook.postDispatch{value: insufficientValue}(testMetadata, testMessage);
    }

    function test_verify_and_onMessageReceived() public {
        bytes memory metadata = _generateMetadata(testMessage);

        vm.prank(address(hook));
        bool verifyResult = ism.verify(metadata, testMessage);
        assertTrue(verifyResult);

        bytes32 messageId = testMessage.id();
        vm.prank(address(zkEvmBridge));
        ism.onMessageReceived(address(hook), uint32(0), abi.encode(messageId));

        assertTrue(ism.verifiedMessages(messageId) & (1 << 255) != 0);
    }

    function test_verify_and_onMessageReceived_withValue() public {
        bytes memory metadata = _generateMetadata(testMessage);

        vm.prank(address(hook));
        bool verifyResult = ism.verify(metadata, testMessage);
        assertTrue(verifyResult);

        bytes32 messageId = testMessage.id();

        vm.deal(address(zkEvmBridge), 101);

        vm.prank(address(zkEvmBridge));
        ism.onMessageReceived{value: 100}(
            address(hook),
            uint32(0),
            abi.encode(messageId)
        );

        uint256 storedValue = ism.verifiedMessages(messageId);
        assertTrue(storedValue & (1 << 255) != 0);
        assertEq(storedValue & ((1 << 255) - 1), 100);
    }

    function test_verify_and_onMessageReceived_multipleMessages() public {
        bytes memory metadata1 = _generateMetadata(testMessage);
        bytes memory testMessage2 = abi.encodePacked("Second message");
        zkEvmBridge.setReturnData(abi.encodePacked(testMessage2.id()));
        bytes memory metadata2 = _generateMetadata(testMessage2);

        vm.prank(address(hook));
        ism.verify(metadata1, testMessage);
        bytes32 messageId1 = testMessage.id();

        vm.deal(address(zkEvmBridge), 500);
        vm.prank(address(zkEvmBridge));
        ism.onMessageReceived{value: 100}(
            address(hook),
            uint32(0),
            abi.encode(messageId1)
        );

        vm.prank(address(hook));
        ism.verify(metadata2, testMessage2);
        bytes32 messageId2 = testMessage2.id();
        vm.prank(address(zkEvmBridge));
        ism.onMessageReceived{value: 200}(
            address(hook),
            uint32(0),
            abi.encode(messageId2)
        );

        uint256 storedValue1 = ism.verifiedMessages(messageId1);
        uint256 storedValue2 = ism.verifiedMessages(messageId2);

        assertTrue(storedValue1 & (1 << 255) != 0);
        assertEq(storedValue1 & ((1 << 255) - 1), 100);
        assertTrue(storedValue2 & (1 << 255) != 0);
        assertEq(storedValue2 & ((1 << 255) - 1), 200);
    }

    function test_onMessageReceived_revertInvalidSender() public {
        bytes memory metadata = _generateMetadata(testMessage);
        vm.prank(address(hook));
        ism.verify(metadata, testMessage);

        bytes32 messageId = testMessage.id();
        vm.expectRevert("PolygonZkevmV2Ism: invalid sender");
        ism.onMessageReceived(address(hook), uint32(0), abi.encode(messageId));
    }

    function test_onMessageReceived_revertInvalidDataLength() public {
        bytes memory metadata = _generateMetadata(testMessage);
        vm.prank(address(hook));
        ism.verify(metadata, testMessage);

        vm.prank(address(zkEvmBridge));
        vm.expectRevert("PolygonZkevmV2Ism: data must be 32 bytes");
        ism.onMessageReceived(address(hook), uint32(0), abi.encode("invalid"));
    }

    function test_onMessageReceived_revertUnauthorizedHook() public {
        bytes memory metadata = _generateMetadata(testMessage);
        vm.prank(address(hook));
        ism.verify(metadata, testMessage);

        bytes32 messageId = testMessage.id();
        vm.deal(address(zkEvmBridge), 5);
        vm.prank(address(zkEvmBridge));
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );
        ism.onMessageReceived{value: 1}(
            address(0x2),
            uint32(0),
            abi.encode(messageId)
        );
    }

    function test_onMessageReceived_revertMsgValueTooLarge() public {
        bytes memory metadata = _generateMetadata(testMessage);
        vm.prank(address(hook));
        ism.verify(metadata, testMessage);

        bytes32 messageId = testMessage.id();
        vm.prank(address(zkEvmBridge));
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: msg.value must be less than 2^255"
        );
        vm.deal(address(zkEvmBridge), 2 ** 255 + 1);
        ism.onMessageReceived{value: 2 ** 255}(
            address(hook),
            uint32(0),
            abi.encode(messageId)
        );
    }

    function test_verify_invalidMessageId() public {
        bytes memory metadata = _generateMetadata(testMessage);
        bytes memory invalidMessage = abi.encodePacked("Invalid message");

        vm.prank(address(hook));
        vm.expectRevert("PolygonZkevmV2Ism: message id does not match payload");
        ism.verify(metadata, invalidMessage);
    }

    function test_onMessageReceived_zeroValue() public {
        bytes memory metadata = _generateMetadata(testMessage);
        vm.prank(address(hook));
        ism.verify(metadata, testMessage);

        bytes32 messageId = testMessage.id();
        vm.prank(address(zkEvmBridge));
        ism.onMessageReceived(address(hook), uint32(0), abi.encode(messageId));

        uint256 storedValue = ism.verifiedMessages(messageId);
        assertTrue(storedValue & (1 << 255) != 0);
        assertEq(storedValue & ((1 << 255) - 1), 0);
    }

    function test_onMessageReceived_maxAllowedValue() public {
        bytes memory metadata = _generateMetadata(testMessage);
        vm.prank(address(hook));
        ism.verify(metadata, testMessage);

        bytes32 messageId = testMessage.id();

        vm.deal(address(zkEvmBridge), 2 ** 255 - 1);

        vm.prank(address(zkEvmBridge));
        ism.onMessageReceived{value: 2 ** 255 - 1}(
            address(hook),
            uint32(0),
            abi.encode(messageId)
        );

        uint256 storedValue = ism.verifiedMessages(messageId);
        assertTrue(storedValue & (1 << 255) != 0);
        assertEq(storedValue & ((1 << 255) - 1), 2 ** 255 - 1);
    }

    function test_getOffchainVerifyInfo() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                ICcipReadIsm.OffchainLookup.selector,
                address(ism),
                offchainUrls,
                abi.encodePacked(testMessage.id()),
                PolygonZkevmV2Ism.verify.selector,
                testMessage
            )
        );
        ism.getOffchainVerifyInfo(testMessage);
    }

    // Helper function to generate metadata for verify
    function _generateMetadata(
        bytes memory message
    ) internal view returns (bytes memory) {
        bytes32[32] memory smtProofLocalExitRoot;
        bytes32[32] memory smtProofRollupExitRoot;
        uint32 globalIndex = 0;
        bytes32 mainnetExitRoot = bytes32(0);
        bytes32 rollupExitRoot = bytes32(0);
        uint32 originNetwork = 0;
        address originAddress = address(0);
        uint256 amount = 0;
        bytes memory payload = abi.encode(message.id());

        return
            abi.encode(
                smtProofLocalExitRoot,
                smtProofRollupExitRoot,
                globalIndex,
                mainnetExitRoot,
                rollupExitRoot,
                originNetwork,
                originAddress,
                ZKEVM_BRIDGE_DESTINATION_NET_ID,
                address(ism),
                amount,
                payload
            );
    }
}
