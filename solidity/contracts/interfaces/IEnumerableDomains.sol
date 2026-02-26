// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/**
 * @title IEnumerableDomains
 * @notice Interface for contracts that track an enumerable set of domains.
 */
interface IEnumerableDomains {
    /**
     * @notice Returns all configured domains.
     * @return An array of domain IDs.
     */
    function domains() external view returns (uint32[] memory);
}
