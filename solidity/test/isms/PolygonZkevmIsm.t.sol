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

import {IPolygonZkEVMBridge} from "../../contracts/interfaces/polygonzkevm/IPolygonZkEVMBridge.sol";
import {PolygonZkevmHook} from "../../contracts/hooks/PolygonZkevmHook.sol";
import {PolygonZkevmIsm} from "../../contracts/isms/hook/PolygonZkevmIsm.sol";

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

    uint32 constant DESTINATION_DOMAIN = 1;
}
