// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// ============ Internal Imports ============
import {IMultisigModule} from "../../interfaces/IMultisigModule.sol";
import {MessageV2} from "../libs/MessageV2.sol";
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
    using MessageV2 for bytes;
    using MultisigModuleMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Mutable Storage ============

    /// @notice The validator threshold for each remote domain.
    mapping(uint32 => uint256) public threshold;

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
     * @param commitment A commitment to the validator set and threshold.
     */
    event ValidatorEnrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount,
        bytes32 commitment
    );

    /**
     * @notice Emitted when a validator is unenrolled from a validator set.
     * @param domain The remote domain of the validator set.
     * @param validator The address of the validator.
     * @param validatorCount The number of enrolled validators in the validator set.
     * @param commitment A commitment to the validator set and threshold.
     */
    event ValidatorUnenrolled(
        uint32 indexed domain,
        address indexed validator,
        uint256 validatorCount,
        bytes32 commitment
    );

    /**
     * @notice Emitted when the quorum threshold is set.
     * @param domain The remote domain of the validator set.
     * @param threshold The new quorum threshold.
     * @param commitment A commitment to the validator set and threshold.
     */
    event ThresholdSet(
        uint32 indexed domain,
        uint256 threshold,
        bytes32 commitment
    );

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() Ownable() {}

    // ============ External Functions ============

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
        require(_validator != address(0), "zero address");
        require(validatorSet[_domain].add(_validator), "already enrolled");
        bytes32 _commitment = _updateCommitment(_domain);
        emit ValidatorEnrolled(
            _domain,
            _validator,
            validatorCount(_domain),
            _commitment
        );
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
        bytes32 _commitment = _updateCommitment(_domain);
        emit ValidatorUnenrolled(
            _domain,
            _validator,
            _validatorCount,
            _commitment
        );
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the validator set.
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
     * @notice Verifies that a quorum of the origin domain's validators signed
     * a checkpoint, and verifies the merkle proof of `_message` against that
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see MultisigModuleMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
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
     * @notice Returns the number of validators enrolled in the validator set.
     * @param _domain The remote domain of the validator set.
     * @return The number of validators enrolled in the validator set.
     */
    function validatorCount(uint32 _domain) public view returns (uint256) {
        return validatorSet[_domain].length();
    }

    // ============ Internal Functions ============

    /**
     * @notice Updates the commitment to the validator set for `_domain`.
     * @param _domain The remote domain of the validator set.
     * @return The commitment to the validator set for `_domain`.
     */
    function _updateCommitment(uint32 _domain) internal returns (bytes32) {
        address[] memory _validators = validators(_domain);
        uint256 _threshold = threshold[_domain];
        bytes32 _commitment = keccak256(
            abi.encodePacked(_threshold, _validators)
        );
        commitment[_domain] = _commitment;
        return _commitment;
    }

    /**
     * @notice Verifies the merkle proof of `_message` against the provided
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see MultisigModuleMetadata.sol)
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
     * @param _metadata ABI encoded module metadata (see MultisigModuleMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
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
            // Ensures the validator set encoded in the metadata matches
            // what we've stored on chain.
            // NB: An empty validator set in `_metadata` will result in a
            // non-zero computed commitment, and this check will fail
            // as the commitment in storage will be zero.
            require(_commitment == commitment[_origin], "!commitment");
            _digest = _getCheckpointDigest(_metadata, _origin);
        }
        uint256 _validatorCount = _metadata.validatorCount();
        uint256 _validatorIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(_digest, _metadata.signatureAt(i));
            // Loop through remaining validators until we find a match
            for (
                ;
                _validatorIndex < _validatorCount &&
                    _signer != _metadata.validatorAt(_validatorIndex);
                ++_validatorIndex
            ) {}
            // Fail if we never found a match
            require(_validatorIndex < _validatorCount, "!threshold");
            ++_validatorIndex;
        }
        return true;
    }

    /**
     * @notice Returns the domain hash that validators are expected to use
     * when signing checkpoints.
     * @param _origin The origin domain of the checkpoint.
     * @param _originMailbox The address of the origin mailbox as bytes32.
     * @return The domain hash.
     */
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

    /**
     * @notice Returns the digest validators are expected to sign when signing checkpoints.
     * @param _metadata ABI encoded module metadata (see MultisigModuleMetadata.sol)
     * @param _origin The origin domain of the checkpoint.
     * @return The digest of the checkpoint.
     */
    function _getCheckpointDigest(bytes calldata _metadata, uint32 _origin)
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
}
