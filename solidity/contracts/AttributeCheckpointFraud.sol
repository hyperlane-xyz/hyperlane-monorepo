// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {TREE_DEPTH} from "./libs/Merkle.sol";
import {CheckpointLib, Checkpoint} from "./libs/CheckpointLib.sol";
import {CheckpointFraudProofs} from "./CheckpointFraudProofs.sol";

enum FraudType {
    NOT_PROVEN,
    Whitelist,
    Premature,
    MessageId,
    Root
}

/**
 * @title AttributeCheckpointFraud
 * @dev The AttributeCheckpointFraud contract is used to attribute fraud to a specific ECDSA checkpoint signer.
 */
contract AttributeCheckpointFraud is Ownable {
    using CheckpointLib for Checkpoint;

    CheckpointFraudProofs public immutable checkpointFraudProofs =
        new CheckpointFraudProofs();

    mapping(address => bool) public merkleTreeWhitelist;

    mapping(address signer => mapping(bytes32 digest => FraudType))
        public attributions;

    function whitelist(address merkleTree) external onlyOwner {
        merkleTreeWhitelist[merkleTree] = true;
    }

    function unattributed(
        Checkpoint calldata checkpoint,
        bytes calldata signature
    ) public view returns (bytes32 digest, address signer) {
        digest = checkpoint.digest();
        signer = ECDSA.recover(digest, signature);
        require(
            attributions[signer][digest] == FraudType.NOT_PROVEN,
            "fraud already attributed to signer for digest"
        );
    }

    function attributeWhitelist(
        Checkpoint calldata checkpoint,
        bytes calldata signature
    ) external {
        (bytes32 digest, address signer) = unattributed(checkpoint, signature);

        require(
            checkpointFraudProofs.isLocal(checkpoint),
            "checkpoint must be local"
        );

        require(
            !merkleTreeWhitelist[checkpoint.merkleTreeAddress()],
            "merkle tree is whitelisted"
        );

        attributions[signer][digest] = FraudType.Whitelist;
    }

    function attributePremature(
        Checkpoint calldata checkpoint,
        bytes calldata signature
    ) external {
        (bytes32 digest, address signer) = unattributed(checkpoint, signature);

        require(
            checkpointFraudProofs.isPremature(checkpoint),
            "checkpoint must be premature"
        );

        attributions[signer][digest] = FraudType.Premature;
    }

    function attributeMessageId(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes32 actualMessageId,
        bytes calldata signature
    ) external {
        (bytes32 digest, address signer) = unattributed(checkpoint, signature);

        require(
            checkpointFraudProofs.isFraudulentMessageId(
                checkpoint,
                proof,
                actualMessageId
            ),
            "checkpoint must have fraudulent message ID"
        );

        attributions[signer][digest] = FraudType.MessageId;
    }

    function attributeRoot(
        Checkpoint calldata checkpoint,
        bytes32[TREE_DEPTH] calldata proof,
        bytes calldata signature
    ) external {
        (bytes32 digest, address signer) = unattributed(checkpoint, signature);

        require(
            checkpointFraudProofs.isFraudulentRoot(checkpoint, proof),
            "checkpoint must have fraudulent root"
        );

        attributions[signer][digest] = FraudType.Root;
    }
}
