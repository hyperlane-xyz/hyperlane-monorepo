pragma solidity >=0.8.0;

import {Checkpoint} from "../libs/CheckpointLib.sol";

interface ICheckpointSubmission {
    event CheckpointSubmitted(
        address validator,
        bytes32 checkpointDigest,
        uint256 index
    );

    function submitCheckpoint(
        Checkpoint calldata checkpoint,
        bytes calldata signature
    ) external;

    function getCheckpointIndex(
        address validator,
        bytes32 checkpointDigest
    ) external view returns (uint256);

    function submittedCheckpoints(
        address validator,
        bytes32 checkpointDigest
    ) external view returns (uint256);

    function validatorNonces(address validator) external view returns (uint256);
}
