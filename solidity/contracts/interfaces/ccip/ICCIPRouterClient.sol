// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// @dev This interface is a partial copy of the IRouterClient interface from the
// @dev @chainlink/contracts-ccip package.
interface ICCIPRouterClient {
    /// @notice Checks if the given chain ID is supported for sending/receiving.
    /// @param chainSelector The chain to check.
    /// @return supported is true if it is supported, false if not.
    function isChainSupported(
        uint64 chainSelector
    ) external view returns (bool supported);

    /// @notice Gets a list of all supported tokens which can be sent or received
    /// to/from a given chain id.
    /// @param chainSelector The chainSelector.
    /// @return tokens The addresses of all tokens that are supported.
    function getSupportedTokens(
        uint64 chainSelector
    ) external view returns (address[] memory tokens);
}
