// SPDX-License-Identifier: MIT or Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Mailbox} from "../../contracts/Mailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {TestMultisigIsm} from "../../contracts/test/TestMultisigIsm.sol";
import {PolygonISM} from "../../contracts/isms/native/PolygonISM.sol";
import {PolygonMessageHook} from "../../contracts/hooks/PolygonMessageHook.sol";
import {TestRecipient} from "../../contracts/test/TestRecipient.sol";

contract PolygonISMTest is Test {
    uint256 internal mainnetFork;
    uint256 internal polygonFork;

    Mailbox internal ethMailbox;
    Mailbox internal polyMailbox;

    TestMultisigIsm internal ism;

    address internal constant CHECKPOINT_MANAGER =
        0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287;
    address internal constant FX_ROOT =
        0xfe5e5D361b2ad62c541bAb87C45a0B9B018389a2;
    address internal constant FX_CHILD =
        0x8397259c983751DAf40400790063935a11afa28a;

    uint8 internal constant VERSION = 0;

    address internal alice = address(0x1);

    PolygonISM internal polygonISM;
    PolygonMessageHook internal polygonHook;

    TestRecipient public testRecipient;
    bytes public testMessage = abi.encodePacked("Hello from the other chain!");

    uint32 public constant MAINNET_DOMAIN = 1;
    uint32 public constant POLYGON_DOMAIN = 137;

    event PolygonMessagePublished(
        address indexed target,
        address indexed sender,
        bytes32 indexed messageId
    );

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    function setUp() public {
        mainnetFork = vm.createFork(vm.rpcUrl("mainnet"));
        polygonFork = vm.createFork(vm.rpcUrl("polygon"));

        testRecipient = new TestRecipient();
    }
}
