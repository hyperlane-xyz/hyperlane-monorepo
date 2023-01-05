// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

interface IValidatorRegistry {
    /// @notice Returns the local domain for validator registrations
    function localDomain() external view returns (uint32);

    /// @notice Returns the mailbox contract for validator registrations
    function mailbox() external view returns (address);

    /// @notice Returns a list of validators that have registered
    function validators() external view returns (address[] memory);

    /**
     * @notice Returns a list of all registrations for all provided validators
     * @param _validators The list of validators to get registrations for
     * @return A list of validator addresses and registered storage metadata
     */
    function getValidatorRegistrations(address[] calldata _validators)
        external
        view
        returns (string[][] memory);

    /**
     * @notice Registers a validator
     * @param _validator The address of the validator being registered
     * @param _storageMetadata Information encoding the location of signed
     * checkpoints
     * @param _signature The signed validator announcement attestation
     * previously specified in this HIP
     * @return True upon success
     */
    function registerValidator(
        address _validator,
        string calldata _storageMetadata,
        bytes calldata _signature
    ) external returns (bool);
}
