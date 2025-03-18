// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IMigratableEntity {
    error AlreadyInitialized();
    error NotFactory();
    error NotInitialized();

    /**
     * @notice Get the factory's address.
     * @return address of the factory
     */
    function FACTORY() external view returns (address);

    /**
     * @notice Get the entity's version.
     * @return version of the entity
     * @dev Starts from 1.
     */
    function version() external view returns (uint64);

    /**
     * @notice Initialize this entity contract by using a given data and setting a particular version and owner.
     * @param initialVersion initial version of the entity
     * @param owner initial owner of the entity
     * @param data some data to use
     */
    function initialize(
        uint64 initialVersion,
        address owner,
        bytes calldata data
    ) external;

    /**
     * @notice Migrate this entity to a particular newer version using a given data.
     * @param newVersion new version of the entity
     * @param data some data to use
     */
    function migrate(uint64 newVersion, bytes calldata data) external;
}
