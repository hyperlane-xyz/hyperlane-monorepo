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
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
// ============ External Imports ============
import {CrossChainEnabledPolygonChild} from "@openzeppelin/contracts/crosschain/polygon/CrossChainEnabledPolygonChild.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonPosIsm
 * @notice Uses the native Polygon Pos Fx Portal Bridge to verify interchain messages.
 */
contract PolygonPosIsm is
    CrossChainEnabledPolygonChild,
    AbstractMessageIdAuthorizedIsm
{
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Constructor ============

    constructor(address _fxChild) CrossChainEnabledPolygonChild(_fxChild) {
        require(
            Address.isContract(_fxChild),
            "PolygonPosIsm: invalid FxChild contract"
        );
    }

    // ============ Internal function ============

    /**
     * @notice Check if sender is authorized to message `preVerifyMessage`.
     */
    function _isAuthorized() internal view override returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
