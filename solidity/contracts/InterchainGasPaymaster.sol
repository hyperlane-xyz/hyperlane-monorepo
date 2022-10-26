// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title InterchainGasPaymaster
 * @notice Manages payments on a source chain to cover gas costs of relaying
 * messages to destination chains.
 */
contract InterchainGasPaymaster is IInterchainGasPaymaster, OwnableUpgradeable {
    // ============ Events ============

    /**
     * @notice Emitted when a payment is made for a message's gas costs.
     * @param outbox The address of the Outbox contract.
     * @param amount The amount of native tokens paid.
     */
    event GasPayment(address indexed outbox, bytes32 messageId, uint256 amount);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() {
        initialize(); // allows contract to be used without proxying
    }

    // ============ External Functions ============

    function initialize() public initializer {
        __Ownable_init();
    }

    /**
     * @notice Deposits msg.value as a payment for the relaying of a message
     * to its destination chain.
     * @param _outbox The address of the Outbox contract.
     * @param _destinationDomain The domain of the message's destination chain.
     */
    function payGasFor(
        address _outbox,
        bytes32 _messageId,
        uint32 _destinationDomain
    ) external payable override {
        // Silence compiler warning. The NatSpec @param requires the parameter to be named.
        // While not used at the moment, future versions of the paymaster may conditionally
        // forward payments depending on the destination domain.
        _destinationDomain;

        emit GasPayment(_outbox, _messageId, msg.value);
    }

    /**
     * @notice Transfers the entire native token balance to the owner of the contract.
     * @dev The owner must be able to receive native tokens.
     */
    function claim() external {
        // Transfer the entire balance to owner.
        (bool success, ) = owner().call{value: address(this).balance}("");
        require(success, "!transfer");
    }
}
