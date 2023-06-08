// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IArbitrumMessageHook} from "../../interfaces/hooks/IArbitrumMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractNativeISM} from "./AbstractNativeISM.sol";

// ============ External Imports ============
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";
import {CrossChainEnabledArbitrumL2} from "@openzeppelin/contracts/crosschain/arbitrum/CrossChainEnabledArbitrumL2.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ArbitrumISM
 * @notice Uses the native Arbitrum bridge to verify interchain messages.
 */
contract ArbitrumISM is AbstractNativeISM, CrossChainEnabledArbitrumL2 {
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ARBITRUM);

    // ============ Public Storage ============

    // Hook deployed on L1 responsible for sending message via the Arbitrum bridge
    IArbitrumMessageHook public l1Hook;

    // ============ Modifiers ============

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     */
    modifier isAuthorized() {
        require(
            _crossChainSender() == address(l1Hook),
            "ArbitrumISM: caller is not authorized."
        );
        _;
    }

    // ============ External Functions ============

    /**
     * @notice Set the hook responsible for sending messages from L1.
     * @param _hook Address of the hook.
     */
    function setArbitrumHook(address _hook) external onlyOwner {
        l1Hook = IArbitrumMessageHook(_onlyContract(_hook, "hook"));
    }

    /**
     * @notice Receive a message from the ArbSys precompile.
     * @dev Only callable by the alias of L1 hook.
     * @param _emitter Address of the emitter.
     * @param _messageId Hyperlane ID for the message.
     */
    function receiveFromHook(address _emitter, bytes32 _messageId)
        external
        isAuthorized
    {
        address emitter = _emitter;
        require(emitter != address(0), "ArbitrumISM: invalid emitter");

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
            string.concat("ArbitrumISM: invalid ", _type)
        );
        return _contract;
    }
}
