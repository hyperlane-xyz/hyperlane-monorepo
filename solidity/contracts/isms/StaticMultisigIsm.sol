// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IMultisigIsm} from "../../interfaces/IMultisigIsm.sol";
import {IMultisigIsmVerifier} from "./MultisigIsmVerifier.sol";
import {Message} from "../libs/Message.sol";
import {StaticMultisigIsmMetadata} from "../libs/StaticMultisigIsmMetadata.sol";
import {MerkleLib} from "../libs/Merkle.sol";

/**
 * @title MultisigIsm
 * @notice Manages per-domain m-of-n Validator sets that are used to verify
 * interchain messages.
 */
contract StaticMultisigIsm is IMultisigIsm {
    IMultisigIsmVerifier internal immutable _verifier;

    uint8 internal immutable _threshold;
    uint8 internal immutable _numValidators;
    address internal immutable _validator0;
    address internal immutable _validator1;
    address internal immutable _validator2;
    address internal immutable _validator3;
    address internal immutable _validator4;
    address internal immutable _validator5;
    address internal immutable _validator6;
    address internal immutable _validator7;
    address internal immutable _validator8;
    address internal immutable _validator9;
    address internal immutable _validator10;
    address internal immutable _validator11;
    address internal immutable _validator12;
    address internal immutable _validator13;
    address internal immutable _validator14;
    address internal immutable _validator15;

    // ============ Constants ============

    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MULTISIG);

    // ============ Constructor ============

    // solhint-disable-next-line no-empty-blocks
    constructor(
        address verifier,
        address[] memory _validators,
        uint8 threshold
    ) {
        require(0 < _validators.length && _validators.length <= 16);
        require(0 < threshold && threshold <= _validators.length);
        _threshold = threshold;
        _verifier = IMultisigIsmVerifier(verifier);
        _numValidators = uint8(_validators.length);
        _validator0 = _numValidators > 0 ? _validators[0] : address(0);
        _validator1 = _numValidators > 1 ? _validators[1] : address(0);
        _validator2 = _numValidators > 2 ? _validators[2] : address(0);
        _validator3 = _numValidators > 3 ? _validators[3] : address(0);
        _validator4 = _numValidators > 4 ? _validators[4] : address(0);
        _validator5 = _numValidators > 5 ? _validators[5] : address(0);
        _validator6 = _numValidators > 6 ? _validators[6] : address(0);
        _validator7 = _numValidators > 7 ? _validators[7] : address(0);
        _validator8 = _numValidators > 8 ? _validators[8] : address(0);
        _validator9 = _numValidators > 9 ? _validators[9] : address(0);
        _validator10 = _numValidators > 10 ? _validators[10] : address(0);
        _validator11 = _numValidators > 11 ? _validators[11] : address(0);
        _validator12 = _numValidators > 12 ? _validators[12] : address(0);
        _validator13 = _numValidators > 13 ? _validators[13] : address(0);
        _validator14 = _numValidators > 14 ? _validators[14] : address(0);
        _validator15 = _numValidators > 15 ? _validators[15] : address(0);
    }

    // ============ Public Functions ============

    function validatorsAndThreshold(bytes calldata)
        public
        view
        returns (address[] memory, uint8)
    {
        return (validators(), _threshold);
    }

    function validators() public view returns (address[] memory) {
        address[] memory _validators = new address[](_numValidators);

        // prettier-ignore
        {
            if (_numValidators > 0) { _validators[0] = _validator0; } else { return _validators; }
            if (_numValidators > 1) { _validators[1] = _validator1; } else { return _validators; }
            if (_numValidators > 2) { _validators[2] = _validator2; } else { return _validators; }
            if (_numValidators > 3) { _validators[3] = _validator3; } else { return _validators; }
            if (_numValidators > 4) { _validators[4] = _validator4; } else { return _validators; }
            if (_numValidators > 5) { _validators[5] = _validator5; } else { return _validators; }
            if (_numValidators > 6) { _validators[6] = _validator6; } else { return _validators; }
            if (_numValidators > 7) { _validators[7] = _validator7; } else { return _validators; }
            if (_numValidators > 8) { _validators[8] = _validator8; } else { return _validators; }
            if (_numValidators > 9) { _validators[9] = _validator9; } else { return _validators; }
            if (_numValidators > 10) { _validators[10] = _validator10; } else { return _validators; }
            if (_numValidators > 11) { _validators[11] = _validator11; } else { return _validators; }
            if (_numValidators > 12) { _validators[12] = _validator12; } else { return _validators; }
            if (_numValidators > 13) { _validators[13] = _validator13; } else { return _validators; }
            if (_numValidators > 14) { _validators[14] = _validator14; } else { return _validators; }
            if (_numValidators > 15) { _validators[15] = _validator15; } else { return _validators; }
        }
        return _validators;
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        view
        returns (bool)
    {
        require(
            _verifier.verify(
                Message.origin(_message),
                Message.nonce(_message),
                Message.id(_message),
                validators(),
                _threshold,
                _metadata
            )
        );
        return true;
    }

    /*
    function verify(bytes calldata _metadata, bytes calldata _message)
        public
        view
        returns (bool)
    {
        require(_verifyMerkleProof(_metadata, _message), "!merkle");
        require(_verifyValidatorSignatures(_metadata, _message), "!sigs");
        return true;
    }


    function validatorAt(uint256 i) internal view returns (address) {
        if (i < 8) {
            if (i < 4) {
                if (i < 2) {
                    return i == 0 ? _validator0 : _validator1;
                } else {
                    return i == 2 ? _validator2 : _validator3;
                }
            } else {
                if (i < 6) {
                    return i == 4 ? _validator4 : _validator5;
                } else {
                    return i == 6 ? _validator6 : _validator7;
                }
            }
        } else {
            if (i < 12) {
                if (i < 10) {
                    return i == 8 ? _validator8 : _validator9;
                } else {
                    return i == 10 ? _validator10 : _validator11;
                }
            } else {
                if (i < 14) {
                    return i == 12 ? _validator12 : _validator13;
                } else {
                    return i == 14 ? _validator14 : _validator15;
                }
            }
        }
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
                _validatorIndex < _numValidators &&
                    _signer != validatorAt(_validatorIndex);
                ++_validatorIndex
            ) {}
            // Fail if we never found a match
            require(_validatorIndex < _numValidators, "!threshold");
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
     */
}
