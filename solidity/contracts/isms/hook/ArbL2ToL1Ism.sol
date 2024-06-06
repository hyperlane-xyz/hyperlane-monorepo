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
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============
import {CrossChainEnabledArbitrumL1} from "@openzeppelin/contracts/crosschain/arbitrum/CrossChainEnabledArbitrumL1.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbL2ToL1Ism
 * @notice Uses the native Arbitrum bridge to verify interchain messages from L2 to L1.
 */
contract ArbL2ToL1Ism is
    CrossChainEnabledArbitrumL1,
    IInterchainSecurityModule
{
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Public Storage ============
    /// @notice address for the authorized hook
    bytes32 public immutable authorizedHook;

    // ============ Constructor ============

    constructor(
        address _bridge,
        bytes32 _hook
    ) CrossChainEnabledArbitrumL1(_bridge) {
        require(
            Address.isContract(_bridge),
            "ArbL2ToL1Ism: invalid Arbitrum Bridge"
        );
        require(_hook != bytes32(0), "ArbL2ToL1Ism: invalid authorized hook");
        authorizedHook = _hook;
    }

    // ============ Initializer ============

    function verify(
        bytes calldata,
        /*_metadata*/
        bytes calldata message
    ) external returns (bool) {
        return _isAuthorized();
    }

    // ============ Internal function ============

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    function _isAuthorized() internal view returns (bool) {
        return
            _crossChainSender() == TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
