// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ITIP20
 * @notice TIP-20 token interface for Tempo's stablecoin standard.
 * @dev Extends IERC20 with TIP-20 specific functions including memo support
 * and policy integration.
 */
interface ITIP20 is IERC20 {
    /**
     * @notice Mints TIP-20 tokens to an address.
     * @dev Reverts on failure (does not return bool like ERC20).
     * @param to The address that will receive the minted tokens.
     * @param amount The amount of tokens to mint.
     */
    function mint(address to, uint256 amount) external;

    /**
     * @notice Mints TIP-20 tokens to an address with a memo.
     * @dev Reverts on failure. Memo is recorded for compliance/audit purposes.
     * @param to The address that will receive the minted tokens.
     * @param amount The amount of tokens to mint.
     * @param memo A bytes32 memo associated with the mint operation.
     */
    function mintWithMemo(address to, uint256 amount, bytes32 memo) external;

    /**
     * @notice Burns tokens from the caller's balance.
     * @dev Reverts on failure.
     * @param amount The amount of tokens to burn.
     */
    function burn(uint256 amount) external;

    /**
     * @notice Burns tokens from the caller's balance with a memo.
     * @dev Reverts on failure. Memo is recorded for compliance/audit purposes.
     * @param amount The amount of tokens to burn.
     * @param memo A bytes32 memo associated with the burn operation.
     */
    function burnWithMemo(uint256 amount, bytes32 memo) external;

    /**
     * @notice Transfers tokens to a recipient with a memo.
     * @dev Reverts on failure. Memo is recorded for compliance/audit purposes.
     * @param to The address to transfer tokens to.
     * @param amount The amount of tokens to transfer.
     * @param memo A bytes32 memo associated with the transfer.
     */
    function transferWithMemo(
        address to,
        uint256 amount,
        bytes32 memo
    ) external;

    /**
     * @notice Transfers tokens from one address to another with a memo.
     * @dev Reverts on failure. Memo is recorded for compliance/audit purposes.
     * @param from The address to transfer tokens from.
     * @param to The address to transfer tokens to.
     * @param amount The amount of tokens to transfer.
     * @param memo A bytes32 memo associated with the transfer.
     * @return True if the operation was successful.
     */
    function transferFromWithMemo(
        address from,
        address to,
        uint256 amount,
        bytes32 memo
    ) external returns (bool);

    /**
     * @notice Gets the transfer policy ID for this token.
     * @return The policy ID as a uint64.
     */
    function transferPolicyId() external view returns (uint64);

    /**
     * @notice Checks if the token is paused.
     * @return True if the token is paused, false otherwise.
     */
    function paused() external view returns (bool);

    /**
     * @notice Gets the ISSUER_ROLE identifier.
     * @return The bytes32 role identifier for issuers.
     */
    function ISSUER_ROLE() external view returns (bytes32);
}
