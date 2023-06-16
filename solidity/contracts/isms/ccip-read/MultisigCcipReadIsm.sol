// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {ICcipReadIsm} from "../../interfaces/isms/ICcipReadIsm.sol";
import {Message} from "../../libs/Message.sol";
import {IMultisigIsm} from "../../interfaces/isms/IMultisigIsm.sol";
import {CcipReadIsmMetadata} from "../../libs/isms/CcipReadIsmMetadata.sol";
import {LegacyCheckpointLib} from "../../libs/LegacyCheckpointLib.sol";
import {AbstractCcipReadIsm} from "./AbstractCcipReadIsm.sol";

/**
 * @title MultiSigCcipReadIsm
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
contract MultiSigCcipReadIsm is AbstractCcipReadIsm, Ownable {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;
    using Message for bytes;
    using CcipReadIsmMetadata for bytes;

    // ============ Mutable Storage ============

    /// @notice The validator threshold for each remote domain.
    mapping(uint32 => uint8) public threshold;

    /// @notice The validator set for each remote domain.
    mapping(uint32 => EnumerableSet.AddressSet) private validatorSet;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in a validator set.
     * @param domain The remote domain of the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The number of enrolled validators in the validator set.
     */
    event ValidatorEnrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount
    );

    /**
     * @notice Emitted when a validator is unenrolled from a validator set.
     * @param domain The remote domain of the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The number of enrolled validators in the validator set.
     */
    event ValidatorUnenrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param domain The remote domain of the validator set.
     * @param threshold The new quorum threshold.
     */
    event ThresholdSet(uint32 indexed domain, uint8 threshold);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Enrolls multiple validators into a validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _domains The remote domains of the validator sets.
     * @param _validators The validators to add to the validator sets.
     * @dev _validators[i] are the validators to enroll for _domains[i].
     */
    function enrollValidators(
        uint32[] calldata _domains,
        address[][] calldata _validators
    ) external onlyOwner {
        uint256 domainsLength = _domains.length;
        require(domainsLength == _validators.length, "!length");
        for (uint256 i = 0; i < domainsLength; i += 1) {
            address[] calldata _domainValidators = _validators[i];
            uint256 validatorsLength = _domainValidators.length;
            for (uint256 j = 0; j < validatorsLength; j += 1) {
                _enrollValidator(_domains[i], _domainValidators[j]);
            }
        }
    }

    /**
     * @notice Enrolls a validator into a validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _domain The remote domain of the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function enrollValidator(uint32 _domain, address _validator)
        external
        onlyOwner
    {
        _enrollValidator(_domain, _validator);
    }

    /**
     * @notice Unenrolls a validator from a validator set.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _domain The remote domain of the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function unenrollValidator(uint32 _domain, address _validator)
        external
        onlyOwner
    {
        require(validatorSet[_domain].remove(_validator), "!enrolled");
        uint256 _validatorCount = validatorCount(_domain);
        require(
            _validatorCount >= threshold[_domain],
            "violates quorum threshold"
        );
        emit ValidatorUnenrolled(_domain, _validator, _validatorCount);
    }

    /**
     * @notice Sets the quorum threshold for multiple domains.
     * @param _domains The remote domains of the validator sets.
     * @param _thresholds The new quorum thresholds.
     */
    function setThresholds(
        uint32[] calldata _domains,
        uint8[] calldata _thresholds
    ) external onlyOwner {
        uint256 length = _domains.length;
        require(length == _thresholds.length, "!length");
        for (uint256 i = 0; i < length; i += 1) {
            setThreshold(_domains[i], _thresholds[i]);
        }
    }

    /**
     * @notice Returns whether an address is enrolled in a validator set.
     * @param _domain The remote domain of the validator set.
     * @param _address The address to test for set membership.
     * @return True if the address is enrolled, false otherwise.
     */
    function isEnrolled(uint32 _domain, address _address)
        external
        view
        returns (bool)
    {
        EnumerableSet.AddressSet storage _validatorSet = validatorSet[_domain];
        return _validatorSet.contains(_address);
    }

    // ============ Public Functions ============

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the validator set.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint32 _domain, uint8 _threshold) public onlyOwner {
        require(
            _threshold > 0 && _threshold <= validatorCount(_domain),
            "!range"
        );
        threshold[_domain] = _threshold;
        emit ThresholdSet(_domain, _threshold);
    }

    /**
     * @notice Gets the current validator set
     * @param _domain The remote domain of the validator set.
     * @return The addresses of the validator set.
     */
    function validators(uint32 _domain) public view returns (address[] memory) {
        EnumerableSet.AddressSet storage _validatorSet = validatorSet[_domain];
        uint256 _validatorCount = _validatorSet.length();
        address[] memory _validators = new address[](_validatorCount);
        for (uint256 i = 0; i < _validatorCount; i++) {
            _validators[i] = _validatorSet.at(i);
        }
        return _validators;
    }

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @param _message Hyperlane formatted interchain message
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThreshold(bytes calldata _message)
        public
        view
        override
        returns (address[] memory, uint8)
    {
        uint32 _origin = _message.origin();
        address[] memory _validators = validators(_origin);
        uint8 _threshold = threshold[_origin];
        return (_validators, _threshold);
    }

    /**
     * @notice Returns the number of validators enrolled in the validator set.
     * @param _domain The remote domain of the validator set.
     * @return The number of validators enrolled in the validator set.
     */
    function validatorCount(uint32 _domain) public view returns (uint256) {
        return validatorSet[_domain].length();
    }

    // ============ Internal Functions ============

    /**
     * @notice Enrolls a validator into a validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _domain The remote domain of the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function _enrollValidator(uint32 _domain, address _validator) internal {
        require(_validator != address(0), "zero address");
        require(validatorSet[_domain].add(_validator), "already enrolled");
        emit ValidatorEnrolled(_domain, _validator, validatorCount(_domain));
    }
}
