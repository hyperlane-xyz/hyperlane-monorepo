// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ITIP20Factory} from "../../contracts/token/interfaces/ITIP20Factory.sol";
import {ITIP20} from "../../contracts/token/interfaces/ITIP20.sol";
import {MockTIP20} from "./MockTIP20.sol";

/**
 * @title MockTIP20Factory
 * @notice Mock implementation of ITIP20Factory for testing.
 * @dev Deploys MockTIP20 instances and tracks them for test assertions.
 */
contract MockTIP20Factory is ITIP20Factory {
    /// @notice Tracks deployed tokens
    mapping(address => bool) public deployedTokens;

    /// @notice Array of all deployed token addresses
    address[] public deployedTokenAddresses;

    /**
     * @notice Creates a new TIP-20 token.
     * @dev Deploys a new MockTIP20 instance and tracks it.
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
    ) external returns (address token) {
        // Deploy new MockTIP20 instance
        MockTIP20 newToken = new MockTIP20(name, symbol);
        token = address(newToken);

        // Transfer ownership to admin
        newToken.transferOwnership(admin);

        // Grant DEFAULT_ADMIN_ROLE to admin so they can grant other roles
        newToken.grantRole(newToken.DEFAULT_ADMIN_ROLE(), admin);

        // Track the deployed token
        deployedTokens[token] = true;
        deployedTokenAddresses.push(token);

        // Emit event
        emit TokenCreated(
            token,
            name,
            symbol,
            currency,
            quoteToken,
            admin,
            salt
        );
    }

    /**
     * @notice Checks if an address is a valid TIP-20 token created by this factory.
     * @param token The address to check.
     * @return True if the address is a valid TIP-20 token, false otherwise.
     */
    function isTIP20(address token) external view returns (bool) {
        return deployedTokens[token];
    }

    /**
     * @notice Computes the deterministic address of a TIP-20 token.
     * @dev This is a simplified mock implementation using keccak256.
     * @param sender The address that will call createToken.
     * @param salt The salt value to be used in createToken.
     * @return token The deterministically computed address of the token.
     */
    function getTokenAddress(
        address sender,
        bytes32 salt
    ) external pure returns (address token) {
        // Simplified deterministic address calculation
        bytes32 hash = keccak256(abi.encodePacked(sender, salt));
        token = address(uint160(uint256(hash)));
    }

    /**
     * @notice Returns the number of deployed tokens.
     * @return The count of deployed tokens.
     */
    function deployedTokenCount() external view returns (uint256) {
        return deployedTokenAddresses.length;
    }

    /**
     * @notice Returns the address of a deployed token by index.
     * @param index The index of the token.
     * @return The address of the token at the given index.
     */
    function getDeployedToken(uint256 index) external view returns (address) {
        return deployedTokenAddresses[index];
    }
}
