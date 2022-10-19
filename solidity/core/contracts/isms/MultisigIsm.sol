// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {IMultisigIsm} from "../../interfaces/IMultisigIsm.sol";
import {Message} from "../libs/Message.sol";
import {MultisigIsmMetadata} from "../libs/MultisigIsmMetadata.sol";

/**
 * @title MultisigIsm
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
contract MultisigIsm is IMultisigIsm, Ownable {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;
    using Message for bytes;
    using MultisigIsmMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Constants ============
    IsmType public constant zoneType = IsmType.MULTISIG;

    // ============ Mutable Storage ============

    // The minimum threshold of validator signatures to constitute a quorum.
    mapping(uint32 => uint256) public threshold;

    // The set of validators.
    mapping(uint32 => EnumerableSet.AddressSet) private validatorSets;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The new number of enrolled validators in the validator set.
     */
    event ValidatorEnrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount
    );

    /**
     * @notice Emitted when a validator is unenrolled from the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The new number of enrolled validators in the validator set.
     */
    event ValidatorUnenrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param threshold The new quorum threshold.
     */
    event ThresholdSet(uint32 indexed domain, uint256 threshold);

    // ============ Constructor ============

    /**
     */
    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function enrollValidator(uint32 _domain, address _validator)
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
    function unenrollValidator(uint32 _domain, address _validator)
        external
        onlyOwner
    {
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

    /**
     * @notice Gets the addresses of the current validator set.
     * @dev There are no ordering guarantees due to the semantics of EnumerableSet.AddressSet.
     * @return The addresses of the validator set.
     */
    function validators(uint32 _domain)
        external
        view
        returns (address[] memory)
    {
        EnumerableSet.AddressSet storage _validatorSet = validatorSets[_domain];
        uint256 _numValidators = _validatorSet.length();
        address[] memory _validators = new address[](_numValidators);
        for (uint256 i = 0; i < _numValidators; i++) {
            _validators[i] = _validatorSet.at(i);
        }
        return _validators;
    }

    // ============ Public Functions ============

    /**
     * @notice Returns whether provided signatures over a checkpoint constitute
     * a quorum of validator signatures.
     * @dev Reverts if `_signatures` is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @dev Does not revert if a signature's signer is not in the validator set.
     * @param _root The merkle root of the checkpoint.
     * @param _index The index of the checkpoint.
     */
    function process(bytes calldata _metadata, bytes calldata _message)
        public
        returns (bool)
    {
        uint32 _origin = _message.origin();
        uint256 _threshold = threshold[_origin];
        require(verifyMerkleProof(_metadata, _message), "!merkle");
        uint256 _validatorSignatureCount = _countValidatorSignatures(
            _origin,
            _metadata
        );
        return _validatorSignatureCount >= _threshold && _threshold > 0;
    }

    function verifyMerkleProof(
        bytes calldata _metadata,
        bytes calldata _message
    ) private returns (bool) {
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(
            _message.id(),
            _metadata.proof(),
            // TODO: The leaf index may not be the same as the nonce if we choose to go
            // with modular storage for outbound messages.
            _message.nonce()
        );
        return _calculatedRoot == _metadata.root();
    }

    /**
     * @notice Returns if `_validator` is enrolled in the validator set.
     * @param _validator The address of the validator.
     * @return TRUE iff `_validator` is enrolled in the validator set.
     */
    function isValidator(uint32 _domain, address _validator)
        public
        view
        returns (bool)
    {
        return validatorSets[_domain].contains(_validator);
    }

    /**
     * @notice Returns the number of validators enrolled in the validator set.
     * @return The number of validators enrolled in the validator set.
     */
    function validatorCount(uint32 _domain) public view returns (uint256) {
        return validatorSets[_domain].length();
    }

    // ============ Internal Functions ============

    function _countValidatorSignatures(bytes calldata _metadata, uint32 _origin)
        internal
        returns (uint256)
    {
        EnumerableSet.AddressSet storage _validatorSet = validatorSets[_origin];
        bytes32 _digest = _signedDigest(_metadata, _origin);
        // To identify duplicates, the signers recovered from _signatures
        // must be sorted in ascending order. previousSigner is used to
        // enforce ordering.
        address _previousSigner = address(0);
        uint256 _validatorSignatureCount = 0;
        uint8 _signatureCount = _signatures.signatureCount();
        for (uint8 i = 0; i < _signatureCount; i++) {
            bytes calldata _signature = _signatures.signatureAt(i);
            address _signer = ECDSA.recover(_digest, _signature);
            // Revert if the signer violates the required sort order.
            require(_previousSigner < _signer, "!sorted signers");
            // If the signer is a validator, increment _validatorSignatureCount.
            if (_validatorSet.contains(_signer)) {
                _validatorSignatureCount++;
            }
            _previousSigner = _signer;
            // emit CheckpointSignature(_signature);
        }
        // Everything you need in order to slash validators for
        // sending fraudulent messages or censoring messages.
        /*
        * @dev This event allows watchers to observe the merkle proof they need
        * to prove fraud on the origin chain.
        emit Something(
            _metadata.root(),
            _metadata.index(),
            _message.origin(),
            _metadata.originMailbox(),
            _metadata.proof(),
            _message.nonce()
        );
        */
        return _validatorSignatureCount;
    }

    function _signedDigest(bytes calldata _metadata, uint32 _origin)
        internal
        pure
        returns (bytes32)
    {
        bytes32 _domainHash = keccak256(
            abi.encodePacked(_origin, _metadata.originMailbox(), "HYPERLANE")
        );
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        _domainHash,
                        _metadata.root(),
                        _metadata.index()
                    )
                )
            );
    }

    /**
     * @notice Enrolls a validator into the validator set.
     * @dev Reverts if `_validator` is already in the validator set.
     * @param _validator The validator to add to the validator set.
     */
    function _enrollValidator(uint32 _domain, address _validator) internal {
        require(_validator != address(0), "zero address");
        require(validatorSets[_domain].add(_validator), "already enrolled");
        emit ValidatorEnrolled(_domain, _validator, validatorCount(_domain));
    }

    /**
     * @notice Unenrolls a validator from the validator set.
     * @dev Reverts if the resulting validator set length is less than
     * the quorum threshold.
     * @dev Reverts if `_validator` is not in the validator set.
     * @param _validator The validator to remove from the validator set.
     */
    function _unenrollValidator(uint32 _domain, address _validator) internal {
        require(validatorSets[_domain].remove(_validator), "!enrolled");
        uint256 _numValidators = validatorCount(_domain);
        require(
            _numValidators >= threshold[_domain],
            "violates quorum threshold"
        );
        emit ValidatorUnenrolled(_domain, _validator, _numValidators);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint32 _domain, uint256 _threshold) internal {
        require(
            _threshold > 0 && _threshold <= validatorCount(_domain),
            "!range"
        );
        threshold[_domain] = _threshold;
        emit ThresholdSet(_domain, _threshold);
    }
}
