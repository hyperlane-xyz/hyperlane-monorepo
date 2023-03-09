// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ External Imports ============
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MerkleLib} from "../libs/Merkle.sol";

import {Message} from "../libs/Message.sol";
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {LegacyMultisigIsmMetadata} from "../libs/LegacyMultisigIsmMetadata.sol";

import {OwnableMOfNAddressSet} from "../libs/OwnableMOfNAddressSet.sol";
import {StorageMOfNAddressSet} from "../libs/StorageMOfNAddressSet.sol";

/**
 * @title LegacyStorageMultisig
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
 */
contract LegacyStorageMultisigIsm is
    OwnableMOfNAddressSet,
    AbstractMultisigIsm
{
    // ============ Libraries ============

    using Message for bytes;
    using LegacyMultisigIsmMetadata for bytes;
    using MerkleLib for MerkleLib.Tree;

    // ============ Events ============

    event CommitmentUpdated(uint32 indexed domain, bytes32 commitment);

    // ============ Constants ============

    uint8 public constant override moduleType =
        uint8(IInterchainSecurityModule.Types.LEGACY_MULTISIG);

    // ============ Public Storage ============
    mapping(uint32 => StorageMOfNAddressSet.AddressSet) private _sets;
    mapping(uint32 => bytes32) private _commitments;

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor() OwnableMOfNAddressSet() {}

    // ============ Public Functions ============

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
        virtual
        override
        returns (address[] memory, uint8)
    {
        return valuesAndThreshold(Message.origin(_message));
    }

    /**
     * @notice Returns whether an address is contained in a set.
     * @param _domain The remote domain of the set.
     * @param _value The address to test for set membership.
     * @return True if the address is contained, false otherwise.
     */
    function contains(uint32 _domain, address _value)
        public
        view
        virtual
        override
        returns (bool)
    {
        return StorageMOfNAddressSet.contains(_sets[_domain], _value);
    }

    /**
     * @notice Gets the current set
     * @param _domain The remote domain of the set.
     * @return The addresses of the set.
     */
    function values(uint32 _domain)
        public
        view
        virtual
        override
        returns (address[] memory)
    {
        return StorageMOfNAddressSet.values(_sets[_domain]);
    }

    /**
     * @notice Gets the current threshold
     * @param _domain The remote domain of the set.
     * @return The threshold of the set.
     */
    function threshold(uint32 _domain)
        public
        view
        virtual
        override
        returns (uint8)
    {
        return StorageMOfNAddressSet.threshold(_sets[_domain]);
    }

    /**
     * @notice Returns the number of values contained in the set.
     * @param _domain The remote domain of the set.
     * @return The number of values contained in the set.
     */
    function length(uint32 _domain)
        public
        view
        virtual
        override
        returns (uint256)
    {
        return StorageMOfNAddressSet.length(_sets[_domain]);
    }

    // ============ Private Functions ============

    /**
     * @notice Adds multiple values to multiple sets.
     * @dev Reverts if `_value` is already in the set.
     * @dev _values[i] are the values to add for _domains[i].
     * @param _domains The remote domains of the sets.
     * @param _values The values to add to the sets.
     */
    function _addMany(uint32[] calldata _domains, address[][] calldata _values)
        internal
        virtual
        override
    {
        require(_domains.length == _values.length);
        for (uint256 i = 0; i < _domains.length; i++) {
            StorageMOfNAddressSet.add(_sets[_domains[i]], _values[i]);
        }
        _updateCommitment(_domain);
    }

    /**
     * @notice Adds a value into a set.
     * @dev Reverts if `_value` is already in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to add to the set.
     */
    function _add(uint32 _domain, address _value) internal virtual override {
        StorageMOfNAddressSet.add(_sets[_domain], _value);
        _updateCommitment(_domain);
    }

    /**
     * @notice Removes a value from a set.
     * @dev Reverts if `_value` is not in the set.
     * @param _domain The remote domain of the set.
     * @param _value The value to remove from the set.
     */
    function _remove(uint32 _domain, address _value) internal virtual override {
        StorageMOfNAddressSet.remove(_sets[_domain], _value);
        _updateCommitment(_domain);
    }

    /**
     * @notice Sets the quorum threshold.
     * @param _domain The remote domain of the set.
     * @param _threshold The new quorum threshold.
     */
    function _setThreshold(uint32 _domain, uint8 _threshold)
        internal
        virtual
        override
    {
        StorageMOfNAddressSet.setThreshold(_sets[_domain], _threshold);
    }

    /**
     * @notice Requires that m-of-n validators verify a merkle root,
     * and verifies a merkle proof of `_message` against that root.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
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
        return valuesAndThreshold(_origin);
    }

    // ============ Internal Functions ============

    /**
     * @notice Verifies the merkle proof of `_message` against the provided
     * checkpoint.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
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
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
     * @param _message Formatted Hyperlane message (see Message.sol).
     */
    function _verifyValidatorSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view returns (bool) {
        uint8 _threshold = _metadata.threshold();
        uint32 _origin = _message.origin();
        // Ensures the validator set encoded in the metadata matches
        // what we've stored on chain.
        // NB: An empty validator set in `_metadata` will result in a
        // non-zero computed commitment, and this check will fail
        // as the commitment in storage will be zero.
        require(
            setMatches(_origin, _threshold, _metadata.validators()),
            "!matches"
        );
        bytes32 _digest = _getCheckpointDigest(_metadata, _origin);
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
     * @notice Returns the digest validators are expected to sign when signing checkpoints.
     * @param _metadata ABI encoded module metadata (see MultisigIsmMetadata.sol)
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
            LegacyMultisigIsmMetadata.originMailbox(_metadata)
        );
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        _domainHash,
                        LegacyMultisigIsmMetadata.root(_metadata),
                        LegacyMultisigIsmMetadata.index(_metadata)
                    )
                )
            );
    }
}
