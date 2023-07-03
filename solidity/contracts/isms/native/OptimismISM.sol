// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {OptimismMessageHook} from "../../hooks/OptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractNativeISM} from "./AbstractNativeISM.sol";

// ============ External Imports ============

import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {CrossChainEnabledOptimism} from "@openzeppelin/contracts/crosschain/optimism/CrossChainEnabledOptimism.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title OptimismISM
 * @notice Uses the native Optimism bridge to verify interchain messages.
 */
contract OptimismISM is CrossChainEnabledOptimism, AbstractNativeISM {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NULL);

    // ============ Public Storage ============

    // Address for Hook on L1 responsible for sending message via the Optimism bridge
    // @dev check https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/2381 for updates to native
    address public l1Hook;

    // ============ Modifiers ============

    /**
     * @notice Check if sender is authorized to message `verifyMessageId`.
     */
    modifier isAuthorized() {
        require(
            _crossChainSender() == l1Hook,
            "OptimismISM: sender is not the hook"
        );
        _;
    }

    // ============ Constructor ============

    constructor(address _l2Messenger) CrossChainEnabledOptimism(_l2Messenger) {
        require(
            Address.isContract(_l2Messenger),
            "OptimismISM: invalid L2Messenger"
        );
    }

    // ============ Initializer ============

    function setOptimismHook(address _l1Hook) external initializer {
        require(_l1Hook != address(0), "OptimismISM: invalid l1Hook");
        l1Hook = _l1Hook;
    }

    // ============ External Functions ============

    /**
     * @notice Receive a message from the L2 messenger.
     * @dev Only callable by the L2 messenger.
     * @param _sender Address of the sender.
     * @param _messageId Hyperlane ID for the message.
     */
    function verifyMessageId(address _sender, bytes32 _messageId)
        external
        isAuthorized
    {
        verifiedMessageIds[_messageId][_sender] = true;

        emit ReceivedMessage(_sender, _messageId);
    }
}
