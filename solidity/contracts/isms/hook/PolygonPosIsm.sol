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

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============
import {CrossChainEnabledPolygonChild} from "@openzeppelin/contracts/crosschain/polygon/CrossChainEnabledPolygonChild.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {FxBaseChildTunnel} from "fx-portal/tunnel/FxBaseChildTunnel.sol";

/**
 * @title PolygonPosIsm
 * @notice Uses the native Polygon Pos Fx Portal Bridge to verify interchain messages.
 */
contract PolygonPosIsm is
    CrossChainEnabledPolygonChild,
    AbstractMessageIdAuthorizedIsm,
    FxBaseChildTunnel
{
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Constructor ============

    constructor(
        address _fxChild
    ) CrossChainEnabledPolygonChild(_fxChild) FxBaseChildTunnel(_fxChild) {
        require(
            Address.isContract(_fxChild),
            "PolygonPosIsm: invalid FxChild contract"
        );
    }

    // ============ Internal function ============

    uint256 public latestStateId;
    address public latestRootMessageSender;
    bytes public latestData;

    function _processMessageFromRoot(
        uint256 stateId,
        address sender,
        bytes memory data
    ) internal override validateSender(sender) {
        latestStateId = stateId;
        latestRootMessageSender = sender;
        latestData = data;
    }

    function processMessageFromRoot() internal override validateSender(sender) {
        latestStateId = stateId;
        latestRootMessageSender = sender;
        latestData = data;
    }

    function sendMessageToRoot(bytes memory message) public {
        _sendMessageToRoot(message);
    }

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
