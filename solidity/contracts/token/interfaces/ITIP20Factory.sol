// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITIP20} from "./ITIP20.sol";

/**
 * @title TIP20Factory
 * @notice Library containing the address of Tempo's TIP20Factory precompile.
 */
library TIP20Factory {
    /**
     * @notice Address of the TIP20Factory precompile.
     */
    address constant TIP20_FACTORY = 0x20Fc000000000000000000000000000000000000;
}

/**
 * @title ITIP20Factory
 * @notice Interface for Tempo's TIP20Factory precompile.
 * @dev Provides factory functions for creating and managing TIP-20 tokens on Tempo.
 * Reference: https://docs.tempo.xyz/protocol/tip20/spec#tip20factory
 */
interface ITIP20Factory {
    /**
     * @notice Emitted when a new TIP-20 token is created.
     * @param token The address of the newly created token.
     * @param name The name of the token.
     * @param symbol The symbol of the token.
     * @param currency The currency identifier for the token.
     * @param quoteToken The quote token used for pricing.
     * @param admin The admin address for the token.
     * @param salt The salt used for deterministic address generation.
     */
    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        string currency,
        ITIP20 quoteToken,
        address admin,
        bytes32 salt
    );

    /**
     * @notice Error raised when attempting to create a token at a reserved address.
     */
    error AddressReserved();

    /**
     * @notice Error raised when the quote token is invalid.
     */
    error InvalidQuoteToken();

    /**
     * @notice Creates a new TIP-20 token.
     * @dev Deploys a new TIP-20 token contract with the specified parameters.
     * The token address is deterministically derived from the sender, salt, and other parameters.
     * Emits TokenCreated event on success.
     * @param name The name of the token.
     * @param symbol The symbol of the token.
     * @param currency The currency identifier for the token.
     * @param quoteToken The ITIP20 token to use as the quote token for pricing.
     * @param admin The admin address that will have administrative privileges over the token.
     * @param salt A bytes32 value used for deterministic address generation.
     * @return token The address of the newly created TIP-20 token.
     */
    function createToken(
        string memory name,
        string memory symbol,
        string memory currency,
        ITIP20 quoteToken,
        address admin,
        bytes32 salt
    ) external returns (address token);

    /**
     * @notice Checks if an address is a valid TIP-20 token created by this factory.
     * @param token The address to check.
     * @return True if the address is a valid TIP-20 token, false otherwise.
     */
    function isTIP20(address token) external view returns (bool);

    /**
     * @notice Computes the deterministic address of a TIP-20 token.
     * @dev This function allows off-chain computation of token addresses before creation.
     * The address is derived from the sender, salt, and token creation parameters.
     * @param sender The address that will call createToken.
     * @param salt The salt value to be used in createToken.
     * @return token The deterministically computed address of the token.
     */
    function getTokenAddress(
        address sender,
        bytes32 salt
    ) external pure returns (address token);
}
