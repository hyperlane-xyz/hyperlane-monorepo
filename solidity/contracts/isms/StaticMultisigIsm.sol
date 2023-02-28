// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../../interfaces/IMultisigIsm.sol";
import {Message} from "../libs/Message.sol";
import {StaticMultisigIsmMetadata} from "../libs/StaticMultisigIsmMetadata.sol";
import {MerkleLib} from "../libs/Merkle.sol";
import {StaticMOfNAddressSet} from "./StaticMOfNAddressSet.sol";

/**
 * @title MultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
 */
contract StaticMultisigIsm is StaticMOfNAddressSet, IMultisigIsm {
    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MULTISIG);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(address[] memory _validators, uint8 threshold)
        StaticMOfNAddressSet(_validators, threshold)
    {}

    // ============ Public Functions ============

    function validatorsAndThreshold(bytes calldata)
        public
        view
        returns (address[] memory, uint8)
    {
        return (values(), _threshold);
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        require(_verifyMerkleProof(_metadata, _message), "!merkle");
        require(_verifyValidatorSignatures(_metadata, _message), "!sigs");
        return true;
    }

    function _verifyMerkleProof(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal pure returns (bool) {
        // calculate the expected root based on the proof
        bytes32 _calculatedRoot = MerkleLib.branchRoot(
            Message.id(_message),
            StaticMultisigIsmMetadata.proof(_metadata),
            Message.nonce(_message)
        );
        return _calculatedRoot == StaticMultisigIsmMetadata.root(_metadata);
    }

    function _verifyValidatorSignatures(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal view returns (bool) {
        bytes32 _digest = _getCheckpointDigest(
            _metadata,
            Message.origin(_message)
        );
        uint256 _validatorIndex = 0;
        // Assumes that signatures are ordered by validator
        for (uint256 i = 0; i < _threshold; ++i) {
            address _signer = ECDSA.recover(
                _digest,
                StaticMultisigIsmMetadata.signatureAt(_metadata, i)
            );
            // Loop through remaining validators until we find a match
            for (
                ;
                _validatorIndex < _numValues &&
                    _signer != valueAt(_validatorIndex);
                ++_validatorIndex
            ) {}
            // Fail if we never found a match
            require(_validatorIndex < _numValues, "!threshold");
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

    function _getCheckpointDigest(bytes calldata _metadata, uint32 _origin)
        internal
        pure
        returns (bytes32)
    {
        bytes32 _domainHash = _getDomainHash(
            _origin,
            StaticMultisigIsmMetadata.originMailbox(_metadata)
        );
        return
            ECDSA.toEthSignedMessageHash(
                keccak256(
                    abi.encodePacked(
                        _domainHash,
                        StaticMultisigIsmMetadata.root(_metadata),
                        StaticMultisigIsmMetadata.index(_metadata)
                    )
                )
            );
    }
}
