pragma solidity >=0.8.0;

import {Checkpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract CheckpointSubmission {
    using CheckpointLib for Checkpoint;

    mapping(address validator => mapping(bytes32 checkpointDigest => uint256 index))
        public submittedCheckpoints;
    mapping(address validator => uint256 nonce) public validatorNonces;

    event CheckpointSubmitted(
        address validator,
        bytes32 checkpointDigest,
        uint256 index
    );

    function submitCheckpoint(
        Checkpoint calldata checkpoint,
        bytes calldata signature
    ) external {
        bytes32 digest = checkpoint.digest();
        address validator = ECDSA.recover(digest, signature);

        require(
            submittedCheckpoints[validator][digest] == 0,
            "Checkpoint already submitted"
        );

        uint256 currentNonce = validatorNonces[validator];
        submittedCheckpoints[validator][digest] = currentNonce + 1;
        validatorNonces[validator] = currentNonce + 1;

        emit CheckpointSubmitted(validator, digest, currentNonce + 1);
    }

    function getCheckpointIndex(
        address validator,
        bytes32 checkpointDigest
    ) external view returns (uint256) {
        return submittedCheckpoints[validator][checkpointDigest];
    }
}
