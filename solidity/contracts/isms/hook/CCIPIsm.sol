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
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title CCIPIsm
 * @notice Uses CCIP hook to verify interchain messages.
 */
contract CCIPIsm is AbstractMessageIdAuthorizedIsm {
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);
    // corresponding to CCIP hook address
    address public immutable hook;

    // ============ Constructor ============

    constructor(address _hook) {
        require(Address.isContract(_hook), "Invalid CCIP hook");
        hook = _hook;
    }

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    function _isAuthorized() internal view override returns (bool) {
        return msg.sender == hook;
    }
}
