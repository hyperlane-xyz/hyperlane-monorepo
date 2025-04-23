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
import {Message} from "../libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============
import {FxBaseRootTunnel} from "fx-portal/contracts/tunnel/FxBaseRootTunnel.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonPosHook
 * @notice Message hook to inform the PolygonPosIsm of messages published through
 * the native PoS bridge.
 */
contract PolygonPosHook is AbstractMessageIdAuthHook, FxBaseRootTunnel {
    using StandardHookMetadata for bytes;
    using Message for bytes;

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
        bytes calldata metadata,
        bytes calldata
    ) internal pure override returns (uint256) {
        return metadata.msgValue(0);
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        require(
            metadata.msgValue(0) == 0,
            "PolygonPosHook: does not support msgValue"
        );
        require(msg.value == 0, "PolygonPosHook: does not support msgValue");

        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (message.id(), metadata.msgValue(0))
        );
        _sendMessageToChild(payload);
    }

    bytes public latestData;

    function _processMessageFromChild(bytes memory data) internal override {
        latestData = data;
    }
}
