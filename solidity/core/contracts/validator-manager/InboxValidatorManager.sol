// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {SchnorrValidatorManager} from "./SchnorrValidatorManager.sol";
import {BN256} from "../../libs/BN256.sol";

/**
 * @title InboxValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxValidatorManager is SchnorrValidatorManager {
    // ============ Libraries ============

    using BN256 for BN256.G1Point;

    // ============ Constructor ============

    /**
     * @dev Reverts if `_validators` has any duplicates.
     * @param _remoteDomain The remote domain of the outbox chain.
     * @param _validators The set of validator addresses.
     * @param _threshold The quorum threshold. Must be greater than or equal
     * to the length of `_validators`.
     */
    // solhint-disable-next-line no-empty-blocks
    constructor(
        uint32 _remoteDomain,
        BN256.G1Point[] memory _validators,
        uint256 _threshold
    ) SchnorrValidatorManager(_remoteDomain, _validators, _threshold) {}

    // ============ External Functions ============

    function process(
        IInbox _inbox,
        Checkpoint calldata _checkpoint,
        uint256[2] calldata _sigScalars,
        BN256.G1Point calldata _nonce,
        bytes32[] calldata _omittedValidatorCompressedPublicKeys,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        _requireQuorum(
            _checkpoint,
            _sigScalars,
            _nonce,
            _omittedValidatorCompressedPublicKeys
        );
        _inbox.process(
            _checkpoint.root,
            _checkpoint.index,
            _message,
            _proof,
            _leafIndex
        );
    }

    // Can we batch process with sovereign guardians?
    function batchProcess(
        IInbox _inbox,
        Checkpoint calldata _checkpoint,
        uint256[2] calldata _sigScalars,
        BN256.G1Point calldata _nonce,
        bytes32[] calldata _omittedValidatorCompressedPublicKeys,
        bytes[] calldata _messages,
        bytes32[32][] calldata _proofs,
        uint256[] calldata _leafIndices
    ) external {
        _requireQuorum(
            _checkpoint,
            _sigScalars,
            _nonce,
            _omittedValidatorCompressedPublicKeys
        );
        _inbox.batchProcess(
            _checkpoint.root,
            _checkpoint.index,
            _messages,
            _proofs,
            _leafIndices
        );
    }

    function _requireQuorum(
        Checkpoint calldata _checkpoint,
        uint256[2] calldata _sigScalars,
        BN256.G1Point calldata _nonce,
        bytes32[] calldata _omittedValidatorCompressedPublicKeys
    ) internal {
        (bool _success, bytes32 _compressedKey) = isQuorum(
            _checkpoint,
            _sigScalars,
            _nonce,
            _omittedValidatorCompressedPublicKeys
        );
        require(_success, "!quorum");
        emit Quorum(
            _checkpoint,
            _sigScalars,
            _compressedKey,
            _nonce.compress(),
            _omittedValidatorCompressedPublicKeys
        );
    }
}
