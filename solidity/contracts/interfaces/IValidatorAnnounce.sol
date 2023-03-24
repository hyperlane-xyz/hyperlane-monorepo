// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IValidatorAnnounce {
    /// @notice Returns the local domain for validator announcements
    function localDomain() external view returns (uint32);

    /// @notice Returns the mailbox contract for validator announcements
    function mailbox() external view returns (address);

    /// @notice Returns a list of validators that have made announcements
    function getAnnouncedValidators() external view returns (address[] memory);

    /**
     * @notice Returns a list of all announced storage locations for `validators`
     * @param _validators The list of validators to get storage locations for
     * @return A list of announced storage locations
     */
    function getAnnouncedStorageLocations(address[] calldata _validators)
        external
        view
        returns (string[][] memory);

    /**
     * @notice Announces a validator signature storage location
     * @param _storageLocation Information encoding the location of signed
     * checkpoints
     * @param _signature The signed validator announcement
     * @return True upon success
     */
    function announce(
        address _validator,
        string calldata _storageLocation,
        bytes calldata _signature
    ) external returns (bool);
}
