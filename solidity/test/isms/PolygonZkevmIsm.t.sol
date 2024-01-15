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
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";
import "forge-std/console.sol";

import {PolygonZkevmHook} from "../../contracts/hooks/PolygonZkevmHook.sol";
import {PolygonZkevmIsm} from "../../contracts/isms/hook/PolygonZkevmIsm.sol";
import {IPolygonZkEVMBridge} from "../../contracts/interfaces/polygonzkevm/IPolygonZkEVMBridge.sol";

contract PolygonZkevmIsmTest is Test {
    using LibBit for uint256;
    using TypeCasts for bytes32;
    using StandardHookMetadata for bytes;
    using Message for bytes;

    uint256 internal mainnetFork;
    uint256 internal polygonZkevmFork;

    uint256 internal constant DEFAULT_GAS_LIMIT = 1_920_000;

    address internal alice = address(0x1);

    // ============ Immutable Variables ============
    uint32 internal constant ORIGIN_DOMAIN = 0;
    uint32 constant DESTINATION_DOMAIN = 1;

    address internal constant L0_POLYGON_ZK_EVM_BRIDGE = address(0);
    address internal constant L1_POLYGON_ZK_EVM_BRIDGE = address(0);

    address internal constant L0_MESSENGER_ADDRESS = address(0);
    address internal constant L1_MESSENGER_ADDRESS = address(0);

    TestRecipient internal testRecipient;
    TestMailbox internal testMailbox;

    PolygonZkevmIsm internal polygonZkevmIsm;
    PolygonZkevmHook internal polygonZkevmHook;

    IPolygonZkEVMBridge internal zkEvmBridge;

    uint256 internal isAccount;

    function setUp() public {
        testRecipient = new TestRecipient();
        testMailbox = new TestMailbox(ORIGIN_DOMAIN);
        zkEvmBridge = IPolygonZkEVMBridge(L0_POLYGON_ZK_EVM_BRIDGE);
        polygonZkevmIsm = new PolygonZkevmIsm(
            address(zkEvmBridge),
            address(testMailbox),
            new string[](0)
        );

        polygonZkevmHook = new PolygonZkevmHook(
            address(testMailbox),
            DESTINATION_DOMAIN,
            TypeCasts.addressToBytes32(address(polygonZkevmIsm)),
            L1_POLYGON_ZK_EVM_BRIDGE,
            0
        );
        isAccount = address(zkEvmBridge).code.length;

        console.logAddress(address(zkEvmBridge));

        console.logUint(isAccount);
    }

    function testFork_quoteDispatch() public {
        // testMailbox.setHook(address(polygonZkevmHook));
        polygonZkevmIsm.setAuthorizedHook(
            TypeCasts.addressToBytes32(address(polygonZkevmHook))
        );

        uint256 fee = polygonZkevmHook.quoteDispatch("0x", "0x");
        assertEq(fee, 0);
    }

    function testFork_supportsMetadata() public {
        bool supportsMetadata = polygonZkevmHook.supportsMetadata("0x");
        assertTrue(supportsMetadata);
    }

    function testFork_postDispatch() public {
        bytes memory metadata = "0x";
        bytes memory message = "0x";
        polygonZkevmHook.postDispatch(metadata, message);

        // expectEmit
        vm.expectEmit(
            address(polygonZkevmHook)
            // ,
            // 'bridgeMessageEvent',
            // abi.encode(
            //     DESTINATION_DOMAIN,
            //     address(polygonZkevmHook),
            //     true,
            //     message.id()
            // )
        );
    }
}
