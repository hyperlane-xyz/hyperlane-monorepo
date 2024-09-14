// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestIsm} from "../../contracts/test/TestIsm.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import {ICcipReadIsm} from "../../contracts/interfaces/isms/ICcipReadIsm.sol";

import {IInterchainSecurityModule} from "../../contracts/interfaces/IInterchainSecurityModule.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../contracts/isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {PolygonZkevmHook} from "../../contracts/hooks/PolygonZkevmHook.sol";
import {PolygonZkevmIsm} from "../../contracts/isms/hook/PolygonZkevmIsm.sol";

import {MockPolygonZkevmBridge} from "../../contracts/mock/MockPolygonZkevmBridge.sol";

import "forge-std/console.sol";

contract PolygonZkevmIsmtest is Test {
    using TypeCasts for bytes32;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // Contracts
    TestPostDispatchHook public requiredHook;
    TestMailbox public mailbox;
    PolygonZkevmIsm public ism;

    TestRecipient internal testRecipient;

    // address internal polygonZkevmBridge;
    MockPolygonZkevmBridge internal polygonZkevmBridge;

    address internal hook;

    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));

    function setUp() public {
        // Setup Hyperlane
        requiredHook = new TestPostDispatchHook();
        mailbox = new TestMailbox(0);
        polygonZkevmBridge = new MockPolygonZkevmBridge();
        ism = new PolygonZkevmIsm(
            address(polygonZkevmBridge),
            uint32(0),
            address(mailbox),
            new string[](0)
        );

        hook = address(0x1);

        ism.setAuthorizedHook(TypeCasts.addressToBytes32(address(hook)));
        testRecipient = new TestRecipient();

        bytes memory messageId = abi.encodePacked(testMessage.id());
        polygonZkevmBridge.setIsm(ism);
        polygonZkevmBridge.setReturnData(abi.encodePacked(messageId));
    }

    function test_moduleType() public view {
        assertEq(
            ism.moduleType(),
            uint8(IInterchainSecurityModule.Types.CCIP_READ)
        );
    }

    function test_getOffchainVerifyInfo() external {
        bytes memory messageId = abi.encodePacked(testMessage.id());

        vm.expectRevert(
            abi.encodeWithSelector(
                ICcipReadIsm.OffchainLookup.selector,
                address(ism),
                new string[](0),
                messageId,
                PolygonZkevmIsm.verify.selector,
                testMessage
            )
        );

        ism.getOffchainVerifyInfo(testMessage);
    }

    // ================== NEED HELP ==================
    function test_verifyPolygonIsm() public {
        bytes32[32] memory smtProof;
        uint32 index = 0;
        bytes32 mainnetExitRoot = bytes32(0x0);
        bytes32 rollupExitRoot = bytes32(0x0);
        uint32 originNetwork = uint32(0);
        address originAddress = address(0x0);
        uint32 destinationNetwork = 1;
        address destinationAddress = address(0x0);
        uint256 amount = 0;
        bytes memory payload = abi.encode(testMessage.id());

        bytes memory metadata = abi.encode(
            smtProof,
            index,
            mainnetExitRoot,
            rollupExitRoot,
            originNetwork,
            originAddress,
            destinationNetwork,
            destinationAddress,
            amount,
            payload
        );
        ism.verify(metadata, testMessage);
    }

    function test_onMessageReceived() public {
        bytes32 messageId = testMessage.id();
        vm.prank(address(polygonZkevmBridge));
        ism.onMessageReceived(address(0x1), uint32(0), abi.encode(messageId));
    }

    function test_onMessageReceived_revertNotAuthBridge() public {
        bytes32 messageId = testMessage.id();

        vm.expectRevert("PolygonZkevmIsm: invalid sender");

        ism.onMessageReceived(address(0x1), uint32(0), abi.encode(messageId));
    }

    function test_onMessageReceived_revertNot32Bytes() public {
        vm.expectRevert("PolygonZkevmIsm: data must be 32 bytes");
        vm.prank(address(polygonZkevmBridge));

        ism.onMessageReceived(address(0x1), uint32(0), abi.encode(testMessage));
    }

    function test_onMessageReceived_revertNoOriginHook() public {
        bytes32 messageId = testMessage.id();
        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: sender is not the hook"
        );

        vm.prank(address(polygonZkevmBridge));
        ism.onMessageReceived(address(0x2), uint32(0), abi.encode(messageId));
    }

    function test_onMessageReceived_revertMsgTooBig() public {
        bytes32 messageId = testMessage.id();
        hoax(address(polygonZkevmBridge), 2 ** 255);

        vm.expectRevert(
            "AbstractMessageIdAuthorizedIsm: msg.value must be less than 2^255"
        );

        ism.onMessageReceived{value: 2 ** 255}(
            address(0x1),
            uint32(0),
            abi.encode(messageId)
        );
    }
}
