// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {IMultisigModule} from "../../interfaces/IMultisigModule.sol";
import {Message} from "../libs/Message.sol";
import {MultisigModuleMetadata} from "../libs/MultisigModuleMetadata.sol";
import {MerkleLib} from "../libs/Merkle.sol";

/**
 * @title MultisigModule
 * @notice Manages an ownable set of validators that ECDSA sign checkpoints to
 * reach a quorum.
 */
contract MultisigModule is IMultisigModule, Ownable {
    // ============ Libraries ============

    using EnumerableSet for EnumerableSet.AddressSet;
    using Message for bytes;
    using MultisigModuleMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Mutable Storage ============

    // The validator threshold for each remote domain.
    mapping(uint32 => uint256) public threshold;

    // The set of validators for each remote domain.
    mapping(uint32 => EnumerableSet.AddressSet) private validatorSets;

    // The hash of the validator set for each remote domain.
    mapping(uint32 => bytes32) public setCommitment;

    // ============ Events ============

    /**
     * @notice Emitted when a validator is enrolled in the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The new number of enrolled validators in the validator set.
     */
    event ValidatorEnrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount,
        bytes32 commitment
    );

    /**
     * @notice Emitted when a validator is unenrolled from the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The new number of enrolled validators in the validator set.
     */
    event ValidatorUnenrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount,
        bytes32 commitment
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param threshold The new quorum threshold.
     */
    event ThresholdSet(
        uint32 indexed domain,
        uint256 threshold,
        bytes32 commitment
    );

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
        require(_validator != address(0), "zero address");
        require(validatorSets[_domain].add(_validator), "already enrolled");
        bytes32 _commitment = _updateCommitment(_domain);
        emit ValidatorEnrolled(
            _domain,
            _validator,
            validatorCount(_domain),
            _commitment
        );
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
        require(validatorSets[_domain].remove(_validator), "!enrolled");
        uint256 _numValidators = validatorCount(_domain);
        require(
            _numValidators >= threshold[_domain],
            "violates quorum threshold"
        );
        bytes32 _commitment = _updateCommitment(_domain);
        emit ValidatorUnenrolled(
            _domain,
            _validator,
            _numValidators,
            _commitment
        );
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _threshold The new quorum threshold.
     */
    function setThreshold(uint32 _domain, uint256 _threshold)
        external
        onlyOwner
    {
        require(
            _threshold > 0 && _threshold <= validatorCount(_domain),
            "!range"
        );
        threshold[_domain] = _threshold;
        bytes32 _commitment = _updateCommitment(_domain);
        emit ThresholdSet(_domain, _threshold, _commitment);
    }

    function isValidator(uint32 _domain, address _validator)
        external
        view
        returns (bool)
    {
        EnumerableSet.AddressSet storage _validatorSet = validatorSets[_domain];
        return _validatorSet.contains(_validator);
    }

    // ============ Public Functions ============

    /**
     * @notice Returns whether provided signatures over a checkpoint constitute
     * a quorum of validator signatures.
     * @dev Reverts if `_signatures` is not sorted in ascending order by the signer
     * address, which is required for duplicate detection.
     * @dev Does not revert if a signature's signer is not in the validator set.
     */
    // TODO: How do you compose ISMs using this interface?
    // Doesn't seem like you can when you have each ISM call into the mailbox
    // directly.
    // Also requires that the
    // Alternatively we could use the

    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        require(_verifyMerkleProof(_metadata, _message), "!merkle");
        require(_verifyValidatorSignatures(_metadata, _message), "!sigs");
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
        return true;
    }

    /**
     * @notice Gets the current validator set, sorted by ascending address.
     * @return The addresses of the validator set.
     */
    function validators(uint32 _domain) public view returns (address[] memory) {
        EnumerableSet.AddressSet storage _validatorSet = validatorSets[_domain];
        uint256 _numValidators = _validatorSet.length();
        address[] memory _validators = new address[](_numValidators);
        // Max address
        address _prev = address(0);
        for (uint256 i = 0; i < _numValidators; i++) {
            address _next = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
            for (uint256 j = 0; j < _numValidators; j++) {
                address _validator = _validatorSet.at(j);
                if (_prev < _validator && _validator < _next) {
                    _next = _validator;
                }
            }
            _validators[i] = _next;
            _prev = _next;
        }
        return _validators;
    }

    /**
     * @notice Returns the number of validators enrolled in the validator set.
     * @return The number of validators enrolled in the validator set.
     */
    function validatorCount(uint32 _domain) public view returns (uint256) {
        return validatorSets[_domain].length();
    }

    // ============ Internal Functions ============

    function _verifyMerkleProof(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal pure returns (bool) {
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

    function _verifyValidatorSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view returns (bool) {
        uint256 _threshold = _metadata.threshold();
        bytes32 _digest;
        {
            uint32 _origin = _message.origin();
            bytes32 _commitment = keccak256(
                abi.encodePacked(_threshold, _metadata.validators())
            );
            // Ensures _validators is sorted by ascending address.
            require(_commitment == setCommitment[_origin], "!commitment");
            _digest = _signedDigest(_metadata, _origin);
        }
        uint256 _validatorIndex = 0;
        // looking for signers within validators
        // assuming that both validators and signatures are sorted
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(_digest, _metadata.signatureAt(i));
            // looping through remaining validators to find a match
            for (
                ;
                _validatorIndex < _threshold &&
                    _signer != _metadata.validatorAt(_validatorIndex);
                ++_validatorIndex
            ) {}
            // checking if we are out of validators
            require(_validatorIndex < _threshold, "!threshold");
            // emit CheckpointSignature(_signature);
            // increasing validators index if match was found
            ++_validatorIndex;
        }
        return true;
    }

    function _getDomainHash(uint32 _origin, bytes32 _originMailbox)
        internal
        pure
        returns (bytes32)
    {
        // Including the origin mailbox address in the signature allows the slashing
        // protocol to enroll multiple mailboxes. Otherwise, a valid signature for
        // mailbox A would be indistinguishable from a fraudulent signature for mailbox
        // B.
        // The slashing protocol should slash if validators sign attestations for
        // anything other than a whitelisted mailbox.
        return
            keccak256(abi.encodePacked(_origin, _originMailbox, "HYPERLANE"));
    }

    function _signedDigest(bytes calldata _metadata, uint32 _origin)
        internal
        pure
        returns (bytes32)
    {
        bytes32 _domainHash = _getDomainHash(
            _origin,
            _metadata.originMailbox()
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

    function _updateCommitment(uint32 _domain) internal returns (bytes32) {
        address[] memory _validators = validators(_domain);
        uint256 _threshold = threshold[_domain];
        bytes32 _commitment = keccak256(
            abi.encodePacked(_threshold, _validators)
        );
        setCommitment[_domain] = _commitment;
        return _commitment;
    }
}
