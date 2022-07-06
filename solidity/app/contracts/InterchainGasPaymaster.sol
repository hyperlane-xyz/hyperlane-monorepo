// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";

/**
 * @title InterchainGasPaymaster
 * @notice Manages payments on a source chain to cover gas costs of relaying
 * messages to destination chains.
 */
contract InterchainGasPaymaster is IInterchainGasPaymaster {
    // ============ Events ============

    /**
     * @notice Emitted when a payment is made for a message's gas costs.
     * @param outbox The address of the Outbox contract.
     * @param leafIndex The index of the message in the Outbox merkle tree.
     * @param amount The amount of native tokens paid.
     */
    event GasPayment(address indexed outbox, uint256 leafIndex, uint256 amount);

    // ============ External Functions ============

    /**
     * @notice Deposits msg.value as a payment for the relaying of a message
     * to its destination chain.
     * @param _outbox The address of the Outbox contract.
     * @param _leafIndex The index of the message in the Outbox merkle tree.
     * @param _destinationDomain The domain of the message's destination chain.
     */
    function payGasFor(
        address _outbox,
        uint256 _leafIndex,
        uint32 _destinationDomain
    ) external payable override {
        // Silence compiler warning. The NatSpec @param requires the parameter to be named.
        // While not used at the moment, future versions of the paymaster may conditionally
        // forward payments depending on the destination domain.
        _destinationDomain;

        emit GasPayment(_outbox, _leafIndex, msg.value);
    }
}
