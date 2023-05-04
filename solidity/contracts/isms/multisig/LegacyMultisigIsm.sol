// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";
import {IMultisigIsm} from "../../interfaces/isms/IMultisigIsm.sol";
import {LegacyMultisigIsmMetadata} from "../../libs/isms/LegacyMultisigIsmMetadata.sol";
import {MerkleLib} from "../../libs/Merkle.sol";
import {LegacyCheckpointLib} from "../../libs/LegacyCheckpointLib.sol";

/**
 * @title MultisigIsm
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
contract LegacyMultisigIsm is IMultisigIsm, Ownable {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;
    using Message for bytes;
    using LegacyMultisigIsmMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.LEGACY_MULTISIG);

    // ============ Mutable Storage ============

    /// @notice The validator threshold for each remote domain.
    mapping(uint32 => uint8) public threshold;

    /// @notice The validator set for each remote domain.
    mapping(uint32 => EnumerableSet.AddressSet) private validatorSet;

    /// @notice A succinct commitment to the validator set and threshold for each remote
    /// domain.
    mapping(uint32 => bytes32) public commitment;

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

    /**
     * @notice Emitted when the validator set or threshold changes.
     * @param domain The remote domain of the validator set.
     * @param commitment A commitment to the validator set and threshold.
     */
    event CommitmentUpdated(uint32 domain, bytes32 commitment);

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
            _updateCommitment(_domains[i]);
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
        _updateCommitment(_domain);
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
        _updateCommitment(_domain);
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

        _updateCommitment(_domain);
    }

    /**
     * @notice Verifies that a quorum of the origin domain's validators signed
     * a checkpoint, and verifies the merkle proof of `_message` against that
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see LegacyMultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        view
        returns (bool)
    {
        require(_verifyMerkleProof(_metadata, _message), "!merkle");
        require(_verifyValidatorSignatures(_metadata, _message), "!sigs");
        return true;
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
        external
        view
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

    /**
     * @notice Updates the commitment to the validator set for `_domain`.
     * @param _domain The remote domain of the validator set.
     * @return The commitment to the validator set for `_domain`.
     */
    function _updateCommitment(uint32 _domain) internal returns (bytes32) {
        address[] memory _validators = validators(_domain);
        uint8 _threshold = threshold[_domain];
        bytes32 _commitment = keccak256(
            abi.encodePacked(_threshold, _validators)
        );
        commitment[_domain] = _commitment;
        emit CommitmentUpdated(_domain, _commitment);
        return _commitment;
    }

    /**
     * @notice Verifies the merkle proof of `_message` against the provided
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see LegacyMultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function _verifyMerkleProof(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal pure returns (bool) {
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(
            _message.id(),
            _metadata.proof(),
            _message.nonce()
        );
        return _calculatedRoot == _metadata.root();
    }

    /**
     * @notice Verifies that a quorum of the origin domain's validators signed
     * the provided checkpoint.
     * @param _metadata ABI encoded module metadata (see LegacyMultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function _verifyValidatorSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view returns (bool) {
        uint8 _threshold = _metadata.threshold();
        bytes32 _digest;
        {
            uint32 _origin = _message.origin();

            bytes32 _commitment = keccak256(
                abi.encodePacked(_threshold, _metadata.validators())
            );
            // Ensures the validator set encoded in the metadata matches
            // what we've stored on chain.
            // NB: An empty validator set in `_metadata` will result in a
            // non-zero computed commitment, and this check will fail
            // as the commitment in storage will be zero.
            require(_commitment == commitment[_origin], "!commitment");
            _digest = LegacyCheckpointLib.digest(
                _origin,
                LegacyMultisigIsmMetadata.originMailbox(_metadata),
                LegacyMultisigIsmMetadata.root(_metadata),
                LegacyMultisigIsmMetadata.index(_metadata)
            );
        }
        uint256 _validatorCount = _metadata.validatorCount();
        uint256 _validatorIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(_digest, _metadata.signatureAt(i));
            // Loop through remaining validators until we find a match
            while (
                _validatorIndex < _validatorCount &&
                _signer != _metadata.validatorAt(_validatorIndex)
            ) {
                ++_validatorIndex;
            }
            // Fail if we never found a match
            require(_validatorIndex < _validatorCount, "!threshold");
            ++_validatorIndex;
        }
        return true;
    }
}
