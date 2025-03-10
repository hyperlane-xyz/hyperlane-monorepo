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

import {PolygonZkevmHook} from "../../contracts/hooks/PolygonZkevmHook.sol";

import "forge-std/console.sol";

contract PolygonZkEVMBridge {
    function bridgeMessage(
        uint32,
        address,
        bool,
        bytes calldata
    ) external payable {}
}

contract PolygonZkevmHooktest is Test {
    using TypeCasts for bytes32;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // Contracts
    TestPostDispatchHook public requiredHook;
    TestMailbox public mailbox;
    TestIsm public ism;
    PolygonZkevmHook public hook;

    TestRecipient internal testRecipient;

    PolygonZkEVMBridge internal polygonZkevmBridge;

    bytes internal testMessage =
        abi.encodePacked("Hello from the other chain!");
    bytes internal testMetadata =
        StandardHookMetadata.overrideRefundAddress(address(this));

    function setUp() public {
        // Setup Hyperlane
        requiredHook = new TestPostDispatchHook();
        mailbox = new TestMailbox(0);
        ism = new TestIsm();
        polygonZkevmBridge = new PolygonZkEVMBridge();
        hook = new PolygonZkevmHook(
            address(mailbox),
            1,
            address(ism),
            address(polygonZkevmBridge),
            1
        );
    }

    function test_postDispatch() public {
        vm.expectCall(
            address(polygonZkevmBridge),
            abi.encodeCall(
                polygonZkevmBridge.bridgeMessage,
                (uint32(1), address(ism), true, abi.encode(testMessage.id()))
            )
        );

        hook.postDispatch(testMetadata, testMessage);
    }

    function test_postDispatch_msgValue() public {
        vm.expectRevert(
            "PolygonzkEVMHook: msgValue must be less than 2 ** 255"
        );
        testMetadata = StandardHookMetadata.overrideMsgValue(2 ** 255);
        hook.postDispatch(testMetadata, testMessage);
    }

    // function test_postDispatch_chainIdNotSupported()

    function test_postDispatch_supportsMetadata() public view {
        assertTrue(hook.supportsMetadata(testMetadata));
    }
}
