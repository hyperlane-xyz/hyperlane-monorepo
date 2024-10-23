// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {Checkpoint, SignedCheckpoint} from "../libs/CheckpointLib.sol";

interface ICheckpointStorage {
    struct Announcement {
        address validator;
        bytes32 mailboxAddress;
        uint32 mailboxDomain;
        string storageLocation;
    }

    struct SignedAnnouncement {
        Announcement value;
        bytes signature;
    }

    struct AgentMetadata {
        string gitSha;
    }

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

    function latestIndex() external view returns (uint32);

    function writeCheckpoint(
        SignedCheckpoint calldata signedCheckpoint
    ) external;

    function fetchCheckpoint(
        address validator,
        uint32 index
    ) external view returns (SignedCheckpoint memory);

    function writeMetadata(string calldata gitSha) external;

    function writeAnnouncement(
        Announcement calldata announcement,
        bytes calldata signature
    ) external;

    function fetchMetadata(
        address validator
    ) external view returns (AgentMetadata memory);

    function fetchAnnouncement(
        address validator
    ) external view returns (SignedAnnouncement memory);
}
