// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IDelegatorHook {
    /**
     * @notice Called when a slash happens.
     * @param subnetwork full identifier of the subnetwork (address of the network concatenated with the uint96 identifier)
     * @param operator address of the operator
     * @param amount amount of the collateral to be slashed
     * @param captureTimestamp time point when the stake was captured
     * @param data some additional data
     */
    function onSlash(
        bytes32 subnetwork,
        address operator,
        uint256 amount,
        uint48 captureTimestamp,
        bytes calldata data
    ) external;
}
