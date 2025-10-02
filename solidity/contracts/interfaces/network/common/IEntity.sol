// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IEntity {
    error NotInitialized();

    /**
     * @notice Get the factory's address.
     * @return address of the factory
     */
    function FACTORY() external view returns (address);

    /**
     * @notice Get the entity's type.
     * @return type of the entity
     */
    function TYPE() external view returns (uint64);

    /**
     * @notice Initialize this entity contract by using a given data.
     * @param data some data to use
     */
    function initialize(bytes calldata data) external;
}
