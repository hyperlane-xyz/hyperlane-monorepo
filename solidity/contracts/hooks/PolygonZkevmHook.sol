// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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

// ============ Internal Imports ============
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IPolygonZkEVMBridge} from "../interfaces/polygonzkevm/IPolygonZkEVMBridge.sol";

/**
 * @title PolygonZkevmHook
 * @notice Message hook to inform the {Polygon zkEVM chain Ism} of messages published through
 * the native Polygon zkEVM bridge bridge.
 */
contract PolygonZkevmHook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    // ============ Immutable Variables ============
    IPolygonZkEVMBridge public immutable zkEvmBridge;

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _zkEvmBridge
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonzkEVMHook: invalid cpManager contract"
        );
        zkEvmBridge = IPolygonZkEVMBridge(_zkEvmBridge);
    }

    /// @dev This value is hardcoded to 0 because the Polygon zkEVM bridge does not support fee quotes
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        require(
            metadata.msgValue(0) < 2 ** 255,
            "PolygonzkEVMHook: msgValue must be less than 2 ** 255"
        );

        zkEvmBridge.bridgeMessage(
            destinationDomain,
            TypeCasts.bytes32ToAddress(ism),
            true,
            payload
        );
    }
}
