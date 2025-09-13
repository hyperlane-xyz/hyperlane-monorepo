// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMigratableEntityProxy {
    /**
     * @notice Upgrade the proxy to a new implementation and call a function on the new implementation.
     * @param newImplementation address of the new implementation
     * @param data data to call on the new implementation
     */
    function upgradeToAndCall(
        address newImplementation,
        bytes calldata data
    ) external;
}
