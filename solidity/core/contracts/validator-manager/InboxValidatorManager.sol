// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
pragma abicoder v2;

// ============ Internal Imports ============
import {IInbox} from "../../interfaces/IInbox.sol";
import {SchnorrValidatorManager} from "./SchnorrValidatorManager.sol";
import {BN256} from "../../libs/BN256.sol";
import "hardhat/console.sol";

/**
 * @title InboxValidatorManager
 * @notice Verifies checkpoints are signed by a quorum of validators and submits
 * them to an Inbox.
 */
contract InboxValidatorManager is SchnorrValidatorManager {
    // ============ Libraries ============

    using BN256 for BN256.G1Point;

    // ============ Events ============

    /**
     * @notice Emitted when a checkpoint has been signed by a quorum
     * of validators and cached on an Inbox.
     * @dev This event allows watchers to observe the signatures they need
     * to prove fraud on the Outbox.
     */
    event Quorum(
        bytes32 root,
        uint256 index,
        bytes32 compressedPublicKey,
        bytes32 compressedNonce,
        uint256 randomness,
        uint256 signature,
        bytes32[] compressedOmitted
    );

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
        bytes32 _root,
        uint256 _index,
        BN256.G1Point calldata nonce,
        uint256 randomness,
        uint256 signature,
        BN256.G1Point[] calldata _omittedValidatorNegPublicKeys,
        bytes calldata _message,
        bytes32[32] calldata _proof,
        uint256 _leafIndex
    ) external {
        require(
            _omittedValidatorNegPublicKeys.length <= threshold,
            "!threshold"
        );
        BN256.G1Point memory _key = verificationKey(
            _omittedValidatorNegPublicKeys
        );
        // Restrict scope to keep stack small enough.
        {
            bytes32 digest = keccak256(
                abi.encodePacked(domainHash, _root, _index)
            );
            require(verify(_key, nonce, randomness, signature, digest), "!sig");
        }
        bytes32[] memory _compressedOmitted = new bytes32[](
            _omittedValidatorNegPublicKeys.length
        );
        for (uint256 i = 0; i < 0; i++) {
            _compressedOmitted[i] = _omittedValidatorNegPublicKeys[i]
                .compress();
        }
        emit Quorum(
            _root,
            _index,
            _key.compress(),
            nonce.compress(),
            randomness,
            signature,
            _compressedOmitted
        );
        _inbox.process(_root, _index, _message, _proof, _leafIndex, "0x00");
    }
}
