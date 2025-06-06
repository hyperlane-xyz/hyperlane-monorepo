// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IHypERC20
 * @notice Interface for Hyperlane ERC20 token with remote transfer functionality
 */
interface IHypERC20 {
    /**
     * @notice Transfers tokens to a recipient on a remote chain
     * @param destination The destination chain ID
     * @param recipient The recipient address on the destination chain
     * @param amount The amount of tokens to transfer
     * @return messageId The ID of the dispatched message
     */
    function transferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external payable returns (bytes32);

    /**
     * @notice Approves a spender to transfer tokens on behalf of the caller
     * @param spender The address that will be allowed to spend tokens
     * @param value The amount of tokens to approve
     * @return success Whether the approval was successful
     */
    function approve(address spender, uint256 value) external returns (bool);
}

/**
 * @title MillenniumFalcon - Smuggles spice across the galaxy in record time
 * @notice This contract is part of the KesselRun spice smuggling infrastructure
 * @dev Allows executing multiple transferRemote calls in a single transaction
 * @dev All transactions in a batch must succeed or the entire batch will be reverted
 */
contract MillenniumFalcon {
    /// @notice The Hyperlane ERC20 token contract
    IHypERC20 public immutable token;

    /**
     * @notice Constructor
     * @param _token The address of the Hyperlane ERC20 token contract
     */
    constructor(address _token) {
        token = IHypERC20(_token);

        // Approve Millennium Falcon to spend "infinite" tokens from the deployer (msg.sender at deploy time)
        // Makes testing easier
        IHypERC20(_token).approve(address(this), type(uint256).max);
    }

    /**
     * @notice Struct representing a single cross-chain transfer call
     * @param destination The destination chain ID
     * @param recipient The recipient address on the destination chain
     * @param amount The amount of tokens to transfer
     * @param value The amount of native token to send with the transfer
     */
    struct TransferCall {
        uint32 destination;
        bytes32 recipient;
        uint256 amount;
        uint256 value;
    }

    /**
     * @notice Executes multiple cross-chain transfers in a single transaction
     * @param calls Array of TransferCall structs containing transfer details
     * @dev Requires sufficient msg.value to cover all transfer values
     * @dev Refunds any excess native token to the sender
     */
    function punchIt(TransferCall[] calldata calls) external payable {
        uint256 totalValue = 0;

        // Execute each transfer call
        for (uint256 i = 0; i < calls.length; i++) {
            totalValue += calls[i].value;

            token.transferRemote{value: calls[i].value}(
                calls[i].destination,
                calls[i].recipient,
                calls[i].amount
            );
        }

        // Ensure sufficient funds were provided
        require(
            totalValue <= msg.value,
            "MillenniumFalcon: Not enough msg.value"
        );

        // Refund any excess native token
        uint256 refund = msg.value - totalValue;
        if (refund > 0) {
            payable(msg.sender).transfer(refund);
        }
    }

    /// @notice Allows the contract to receive native token
    receive() external payable {}
}
