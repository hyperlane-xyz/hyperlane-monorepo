pragma solidity >=0.8.0;

import {Checkpoint, SignedCheckpoint, CheckpointLib} from "./libs/CheckpointLib.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract CheckpointStorage {
    using CheckpointLib for Checkpoint;
    using ECDSA for bytes32;

    uint32 public validatorLatestIndex;
    struct Announcement {
        address validator;
        bytes32 mailboxAddress;
        uint32 mailboxDomain;
        string storageLocation;
    }
    struct SignedAnnouncement {
        Announcement value;
        bytes signature; // 72 bytes
    }
    struct AgentMetadata {
        string gitSha;
    }

    mapping(address validator => mapping(uint32 index => SignedCheckpoint signedCheckpoint))
        public submittedCheckpoints;
    mapping(address validator => SignedAnnouncement signedAnnouncement)
        public validatorAnnouncements;
    mapping(address validator => AgentMetadata agentMetadata)
        public validatorMetadata;

    event CheckpointSubmitted(
        address validator,
        SignedCheckpoint signedCheckpoint,
        uint32 index
    );
    event MetadataUpdated(address validator, string gitSha);
    event AnnouncementUpdated(
        address validator,
        SignedAnnouncement signedAnnouncement
    );

    function latestIndex() external view returns (uint32) {
        return validatorLatestIndex;
    }

    function writeCheckpoint(
        SignedCheckpoint calldata signedCheckpoint
    ) external {
        address validator = msg.sender;
        require(
            CheckpointLib.isEmpty(
                submittedCheckpoints[validator][
                    signedCheckpoint.checkpoint.index
                ].checkpoint
            ),
            "Checkpoint already submitted"
        );
        if (signedCheckpoint.checkpoint.index > validatorLatestIndex) {
            validatorLatestIndex = signedCheckpoint.checkpoint.index;
        }

        emit CheckpointSubmitted(
            validator,
            signedCheckpoint,
            signedCheckpoint.checkpoint.index
        );
    }

    function fetchCheckpoint(
        address validator,
        uint32 index
    ) external view returns (SignedCheckpoint memory) {
        return submittedCheckpoints[validator][index];
    }

    function writeMetadata(string calldata gitSha) external {
        validatorMetadata[msg.sender] = AgentMetadata(gitSha);
        emit MetadataUpdated(msg.sender, gitSha);
    }

    function writeAnnouncement(
        Announcement calldata announcement,
        bytes calldata signature
    ) external {
        require(announcement.validator == msg.sender, "Validator mismatch");
        SignedAnnouncement memory signedAnnouncement = SignedAnnouncement(
            announcement,
            signature
        );
        validatorAnnouncements[msg.sender] = signedAnnouncement;
        emit AnnouncementUpdated(msg.sender, signedAnnouncement);
    }

    function fetchMetadata(
        address validator
    ) external view returns (AgentMetadata memory) {
        return validatorMetadata[validator];
    }

    function fetchAnnouncement(
        address validator
    ) external view returns (SignedAnnouncement memory) {
        return validatorAnnouncements[validator];
    }
}
