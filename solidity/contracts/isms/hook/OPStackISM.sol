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
import {CrossChainEnabledOptimism} from "./crossChainEnabled/optimism/CrossChainEnabledOptimism.sol";

// ============ External Imports ============

import {AddressAliasHelper} from "@eth-optimism/contracts/standards/AddressAliasHelper.sol";
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OptimismISM
 * @notice Uses the native Optimism bridge to verify interchain messages.
 * @dev V3 WIP
 */
contract OPStackIsm is
    CrossChainEnabledOptimism,
    AbstractMessageIdAuthorizedIsm
{
    using Address for address payable;
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Constructor ============

    constructor(address _l2Messenger) CrossChainEnabledOptimism(_l2Messenger) {
        require(
            Address.isContract(_l2Messenger),
            "OPStackIsm: invalid L2Messenger"
        );
    }

    // ============ Internal function ============

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    function _isAuthorized() internal view override returns (bool) {
        return _crossChainSender() == authorizedHook;
    }

    /**
     * @notice Verify message from the L1 and transfer value.
     * @dev Only callable by the L2 messenger.
     * @param _messageId Hyperlane ID for the message.
     */
    function verifyMessageId(bytes32 _messageId, address payable recipient)
        external
        payable
    {
        verifyMessageId(_messageId);

        if (msg.value > 0) {
            if (recipient.isContract()) {
                recipient = payable(
                    AddressAliasHelper.applyL1ToL2Alias(recipient)
                );
                recipient.sendValue(msg.value);
            } else {
                recipient.sendValue(msg.value);
            }
        }
    }
}
