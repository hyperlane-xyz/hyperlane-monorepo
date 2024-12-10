// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint, SignedCheckpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {IValidatorAnnounce} from "./interfaces/IValidatorAnnounce.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title CheckpointStorage
 * @notice Stores validator checkpoints and metadata. Works alongside ValidatorAnnounce
 * which handles the validator announcements separately.
 */
contract CheckpointStorage {
    using CheckpointLib for Checkpoint;
    using ECDSA for bytes32;

    // ============ State Variables ============

    mapping(address => uint32) public validatorLatestIndices;
    IValidatorAnnounce public immutable validatorAnnounce;

    struct AgentMetadata {
        string gitSha;
    }

    // Mapping of validator => index => signed checkpoint
    mapping(address validator => mapping(uint32 index => SignedCheckpoint signedCheckpoint))
        public submittedCheckpoints;

    // Mapping of validator => metadata
    mapping(address validator => AgentMetadata agentMetadata)
        public validatorMetadata;

    // ============ Events ============

    event CheckpointSubmitted(
        address indexed validator,
        SignedCheckpoint signedCheckpoint,
        uint32 index
    );

    event MetadataUpdated(address indexed validator, string gitSha);

    // ============ Constructor ============

    constructor(address _validatorAnnounce) {
        validatorAnnounce = IValidatorAnnounce(_validatorAnnounce);
    }

    // ============ External Functions ============

    /**
     * @notice Returns the latest checkpoint index
     * @return The latest checkpoint index
     */
    function latestIndex() external view returns (uint32) {
        return validatorLatestIndex;
    }

    /**
     * @notice Write a new checkpoint
     * @param signedCheckpoint The signed checkpoint to write
     */
    function writeCheckpoint(
        SignedCheckpoint calldata signedCheckpoint
    ) external {
        address validator = msg.sender;

        // Ensure validator has announced via ValidatorAnnounce
        require(
            validatorAnnounce.hasAnnounced(validator),
            "Validator not announced"
        );

        // Verify the signature
        bytes32 digest = CheckpointLib.digest(signedCheckpoint.checkpoint);
        address signer = ECDSA.recover(
            ECDSA.toEthSignedMessageHash(digest),
            signedCheckpoint.signature
        );
        require(signer == validator, "!signature");

        // Ensure checkpoint hasn't been submitted
        require(
            CheckpointLib.isEmpty(
                submittedCheckpoints[validator][
                    signedCheckpoint.checkpoint.index
                ].checkpoint
            ),
            "Checkpoint already submitted"
        );

        if (
            signedCheckpoint.checkpoint.index >
            validatorLatestIndices[validator]
        ) {
            validatorLatestIndices[validator] = signedCheckpoint
                .checkpoint
                .index;
        }

        // Store checkpoint
        submittedCheckpoints[validator][
            signedCheckpoint.checkpoint.index
        ] = signedCheckpoint;

        emit CheckpointSubmitted(
            validator,
            signedCheckpoint,
            signedCheckpoint.checkpoint.index
        );
    }

    /**
     * @notice Fetch a checkpoint for a specific validator and index
     * @param validator The validator address
     * @param index The checkpoint index
     * @return The signed checkpoint
     */
    function fetchCheckpoint(
        address validator,
        uint32 index
    ) external view returns (SignedCheckpoint memory) {
        return submittedCheckpoints[validator][index];
    }

    /**
     * @notice Update validator metadata
     * @param gitSha The git SHA to store
     */
    function writeMetadata(string calldata gitSha) external {
        // Ensure validator has announced via ValidatorAnnounce
        require(
            validatorAnnounce.hasAnnounced(msg.sender),
            "Validator not announced"
        );

        validatorMetadata[msg.sender] = AgentMetadata(gitSha);
        emit MetadataUpdated(msg.sender, gitSha);
    }

    /**
     * @notice Fetch validator metadata
     * @param validator The validator address
     * @return The validator's metadata
     */
    function fetchMetadata(
        address validator
    ) external view returns (AgentMetadata memory) {
        return validatorMetadata[validator];
    }
}
