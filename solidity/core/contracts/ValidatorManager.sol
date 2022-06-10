// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IValidatorManager} from "../interfaces/IValidatorManager.sol";
import {BN256} from "../libs/BN256.sol";
import {ValidatorSet} from "../libs/ValidatorSet.sol";
// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ValidatorManager is IValidatorManager, Ownable {
    // ============ Libraries ============

    using BN256 for BN256.G1Point;
    using ValidatorSet for ValidatorSet.Set;

    // ============ Mutable Storage ============

    // Mapping of domain to validator set.
    mapping(uint32 => ValidatorSet.Set) sets;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in the validator set.
     */
    event EnrollValidator(
        uint32 indexed domain,
        BN256.G1Point indexed validator,
        BN256.G1Point indexed aggregateKey
    );

    /**
     * @notice Emitted when a validator is unenrolled from the validator set.
     */
    event UnenrollValidator(
        uint32 indexed domain,
        BN256.G1Point indexed validator,
        BN256.G1Point indexed aggregateKey
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param threshold The new quorum threshold.
     */
    event SetThreshold(uint32 indexed domain, uint256 threshold);

    // ============ Constructor ============

    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function enrollValidator(uint32 _domain, BN256.G1Point calldata _validator)
        external
        onlyOwner
    {
        _enrollValidator(_domain, _validator);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function unenrollValidator(
        uint32 _domain,
        BN256.G1Point calldata _validator
    ) external onlyOwner {
        _unenrollValidator(_domain, _validator);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint32 _domain, uint256 _threshold)
        external
        onlyOwner
    {
        _setThreshold(_domain, _threshold);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns if `_validator` is enrolled in the validator set.
     * @param _validator The address of the validator.
     * @return TRUE iff `_validator` is enrolled in the validator set.
     */
    function isEnrolled(uint32 _domain, BN256.G1Point memory _validator)
        public
        view
        returns (bool)
    {
        return sets[_domain].isValidator(_validator);
    }

    function verificationKey(uint32 _domain, bytes32[] calldata _missing)
        external
        view
        returns (BN256.G1Point memory)
    {
        return sets[_domain].verificationKey(_missing);
    }

    // ============ Internal Functions ============

    // TODO: This function needs to verify a PoP to protect against rogue key attacks.
    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function _enrollValidator(uint32 _domain, BN256.G1Point calldata _validator)
        internal
    {
        sets[_domain].add(_validator);
        emit EnrollValidator(_domain, _validator, sets[_domain].aggregateKey);
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if the resulting validator set length is less than
     * the quorum threshold.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function _unenrollValidator(
        uint32 _domain,
        BN256.G1Point calldata _validator
    ) internal {
        sets[_domain].remove(_validator);
        emit UnenrollValidator(_domain, _validator, sets[_domain].aggregateKey);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint32 _domain, uint256 _threshold) internal {
        sets[_domain].setThreshold(_threshold);
        emit SetThreshold(_domain, _threshold);
    }
}
