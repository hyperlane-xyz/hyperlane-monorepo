// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
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
        uint8(IInterchainSecurityModule.Types.OPTIMISM);

    // Optimism's native CrossDomainMessenger deployed on L2
    // @dev Only allowed to call `receiveFromHook`.
    ICrossDomainMessenger public immutable l2Messenger;

    // ============ Public Storage ============

    // Hook deployed on L1 responsible for sending message via the Optimism bridge
    IOptimismMessageHook public l1Hook;

    // ============ Modifiers ============

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     */
    modifier isAuthorized() {
        require(
            _crossChainSender() == address(l1Hook),
            "OptimismISM: caller is not the owner"
        );
        _;
    }

    // ============ Constructor ============

    constructor(address _l2Messenger) CrossChainEnabledOptimism(_l2Messenger) {
        l2Messenger = ICrossDomainMessenger(
            _onlyContract(_l2Messenger, "l2Messenger")
        );
    }

    // ============ External Functions ============

    /**
     * @notice Set the hook responsible for sending messages from L1.
     * @param _hook Address of the hook.
     */
    function setOptimismHook(address _hook) external onlyOwner {
        l1Hook = IOptimismMessageHook(_onlyContract(_hook, "hook"));
    }

    /**
     * @notice Receive a message from the L2 messenger.
     * @dev Only callable by the L2 messenger.
     * @param _emitter Address of the emitter.
     * @param _messageId Hyperlane ID for the message.
     */
    function receiveFromHook(address _emitter, bytes32 _messageId)
        external
        isAuthorized
    {
        address emitter = _emitter;
        require(emitter != address(0), "OptimismISM: invalid emitter");

        _setEmitter(emitter, _messageId);

        emit ReceivedMessage(emitter, _messageId);
    }

    // ============ Internal Functions ============

    function _onlyContract(address _contract, string memory _type)
        internal
        view
        returns (address)
    {
        require(
            Address.isContract(_contract),
            string.concat("OptimismISM: invalid ", _type)
        );
        return _contract;
    }
}
