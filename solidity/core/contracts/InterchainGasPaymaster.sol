// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

error OwnerClaimBalanceFailed();

/**
 * @title InterchainGasPaymaster
 * @notice Manages payments on a source chain to cover gas costs of proving
 * & processing messages on destination chains.
 * @dev This contract is only intended for paying for messages sent via a specific
 * Outbox contract on the same source chain.
 */
contract InterchainGasPaymaster is IInterchainGasPaymaster, Ownable {
    // ============ Events ============

    /**
     * @notice Emitted when a payment is made for a message's gas costs.
     * @param leafIndex The index of the message in the Outbox merkle tree.
     * @param amount The amount of native tokens paid.
     */
    event GasPayment(uint256 indexed leafIndex, uint256 amount);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Deposits the msg.value as a payment for the proving & processing
     * of a message on its destination chain.
     * @param _leafIndex The index of the message in the Outbox merkle tree.
     */
    function payGasFor(uint256 _leafIndex) external payable override {
        emit GasPayment(_leafIndex, msg.value);
    }

    /**
     * @notice Transfers the entire native token balance to the owner of the contract.
     * @dev The owner must be able to receive native tokens.
     */
    function claim() external {
        // Transfer the entire balance to owner.
        (bool success, ) = owner().call{value: address(this).balance}("");
        if (!success) {
            revert OwnerClaimBalanceFailed();
        }
    }
}
