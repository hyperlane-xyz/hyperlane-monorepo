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
import {FxBaseRootTunnel} from "fx-portal/tunnel/FxBaseRootTunnel.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonPosHook
 * @notice Message hook to inform the PolygonPosIsm of messages published through
 * the native PoS bridge.
 */
contract PolygonPosHook is AbstractMessageIdAuthHook, FxBaseRootTunnel {
    using StandardHookMetadata for bytes;

    // ============ Constants ============

    // Gas limit for sending messages to L2
    // First 1.92e6 gas is provided by Optimism, see more here:
    // https://community.optimism.io/docs/developers/bridge/messaging/#for-l1-%E2%87%92-l2-transactions
    uint32 internal constant GAS_LIMIT = 1_920_000;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _cpManager,
        address _fxRoot
    )
        AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism)
        FxBaseRootTunnel(_cpManager, _fxRoot)
    {
        // FIX: check needed?
        require(
            Address.isContract(_cpManager),
            "PolygonPosHook: invalid cpManager contract"
        );
        require(
            Address.isContract(_fxRoot),
            "PolygonPosHook: invalid fxRoot contract"
        );
    }

    // ============ Internal functions ============
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return 0; // gas subsidized by the L2
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        require(
            metadata.msgValue(0) < 2 ** 255,
            "OPStackHook: msgValue must be less than 2 ** 255"
        );
        _sendMessageToChild(payload);
    }

    // FIX: connect to mailbox, check how to do bidrectional
    bytes public latestData;

    function _processMessageFromChild(bytes memory data) internal override {
        latestData = data;
    }
}
