// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Checkpoint} from "./libs/CheckpointLib.sol";

/**
 * @title CheckpointStorage
 * @notice Stores validator checkpoints and metadata on-chain.
 *         Validators can publish their signed checkpoints directly to this
 *         contract instead of using off-chain storage like S3 or GCS.
 *         The storage location format is: onchain://chainName/contractAddress
 *
 * @dev The stored checkpoint struct matches the Hyperlane Checkpoint type:
 *      Checkpoint(merkle_tree_hook_address, mailbox_domain, root, index)
 *      The signed checkpoint includes a CheckpointWithMessageId and an
 *      ECDSA signature (65 bytes: r || s || v).
 */
contract CheckpointStorage {
    // ============ Structs ============

    /// @notice A Hyperlane checkpoint
    /// @dev Matches the Rust Checkpoint struct in hyperlane-core
    struct HyperlaneCheckpoint {
        bytes32 merkleTreeHookAddress;
        uint32 mailboxDomain;
        bytes32 root;
        uint32 index;
    }

    /// @notice A checkpoint with message ID
    struct HyperlaneCheckpointWithMessageId {
        HyperlaneCheckpoint checkpoint;
        bytes32 messageId;
    }

    /// @notice A signed checkpoint with message ID
    struct SignedCheckpointWithMessageId {
        HyperlaneCheckpointWithMessageId value;
        bytes signature;
    }

    struct AgentMetadata {
        string gitSha;
    }

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

    // ============ State Variables ============

    /// @notice Maps validator => index => signed checkpoint with message ID
    mapping(address => mapping(uint32 => SignedCheckpointWithMessageId))
        public submittedCheckpoints;

    /// @notice Maps validator => latest submitted checkpoint index
    mapping(address => uint32) public validatorLatestIndices;

    /// @notice Maps validator => metadata
    mapping(address => AgentMetadata) public validatorMetadata;

    /// @notice Maps validator => announcement
    mapping(address => SignedAnnouncement) public announcements;

    /// @notice Reference to the ValidatorAnnounce contract for consistency
    address public immutable validatorAnnounce;

    // ============ Events ============

    event CheckpointSubmitted(
        address indexed validator,
        HyperlaneCheckpointWithMessageId checkpoint,
        bytes signature,
        uint32 index
    );

    event MetadataUpdated(address indexed validator, string gitSha);

    event AnnouncementUpdated(
        address indexed validator,
        Announcement announcement,
        bytes signature
    );

    // ============ Constructor ============

    constructor(address _validatorAnnounce) {
        validatorAnnounce = _validatorAnnounce;
    }

    // ============ Write Functions ============

    /// @notice Writes a signed checkpoint to the contract
    /// @param _signedCheckpoint The signed checkpoint to store
    function writeCheckpoint(SignedCheckpointWithMessageId calldata _signedCheckpoint) external {
        // Derive the validator address from the checkpoint hash and signature
        bytes32 checkpointHash = keccak256(
            abi.encode(
                _signedCheckpoint.value.checkpoint.merkleTreeHookAddress,
                _signedCheckpoint.value.checkpoint.mailboxDomain,
                _signedCheckpoint.value.checkpoint.root,
                _signedCheckpoint.value.checkpoint.index,
                _signedCheckpoint.value.messageId
            )
        );
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", checkpointHash)
        );
        address validator = _recoverSigner(ethSignedHash, _signedCheckpoint.signature);
        uint32 index = _signedCheckpoint.value.checkpoint.index;

        submittedCheckpoints[validator][index] = _signedCheckpoint;

        if (index > validatorLatestIndices[validator]) {
            validatorLatestIndices[validator] = index;
        }

        emit CheckpointSubmitted(
            validator,
            _signedCheckpoint.value,
            _signedCheckpoint.signature,
            index
        );
    }

    /// @notice Writes agent metadata
    /// @param _gitSha The git SHA of the agent
    function writeMetadata(string calldata _gitSha) external {
        validatorMetadata[msg.sender] = AgentMetadata(_gitSha);
        emit MetadataUpdated(msg.sender, _gitSha);
    }

    /// @notice Writes a signed announcement
    /// @param _signedAnnouncement The signed announcement to store
    function writeAnnouncement(SignedAnnouncement calldata _signedAnnouncement) external {
        address validator = _signedAnnouncement.value.validator;
        // Verify the signature matches the validator
        bytes32 digest = keccak256(
            abi.encode(
                _signedAnnouncement.value.validator,
                _signedAnnouncement.value.mailboxAddress,
                _signedAnnouncement.value.mailboxDomain,
                _signedAnnouncement.value.storageLocation
            )
        );
        bytes32 ethSignedDigest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)
        );
        address recovered = _recoverSigner(ethSignedDigest, _signedAnnouncement.signature);
        require(recovered == validator, "signature does not match validator");

        announcements[validator] = _signedAnnouncement;
        emit AnnouncementUpdated(
            validator,
            _signedAnnouncement.value,
            _signedAnnouncement.signature
        );
    }

    // ============ Read Functions ============

    /// @notice Fetches a signed checkpoint for a given validator and index
    /// @param _validator The validator address
    /// @param _index The checkpoint index
    /// @return The signed checkpoint
    function fetchCheckpoint(
        address _validator,
        uint32 _index
    ) external view returns (SignedCheckpointWithMessageId memory) {
        return submittedCheckpoints[_validator][_index];
    }

    /// @notice Fetches the latest index for a given validator
    /// @param _validator The validator address
    /// @return The latest checkpoint index
    function latestIndex(address _validator) external view returns (uint32) {
        return validatorLatestIndices[_validator];
    }

    /// @notice Fetches metadata for a given validator
    /// @param _validator The validator address
    /// @return The agent metadata
    function fetchMetadata(
        address _validator
    ) external view returns (AgentMetadata memory) {
        return validatorMetadata[_validator];
    }

    /// @notice Fetches the announcement for a given validator
    /// @param _validator The validator address
    /// @return The signed announcement
    function fetchAnnouncement(
        address _validator
    ) external view returns (SignedAnnouncement memory) {
        return announcements[_validator];
    }

    // ============ Internal Functions ============

    /// @notice Recovers the signer address from an ECDSA signature
    /// @param _hash The signed hash
    /// @param _signature The 65-byte ECDSA signature (r || s || v)
    /// @return The recovered signer address
    function _recoverSigner(
        bytes32 _hash,
        bytes calldata _signature
    ) internal pure returns (address) {
        require(_signature.length == 65, "invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_signature.offset)
            s := calldataload(add(_signature.offset, 0x20))
            v := byte(0, calldataload(add(_signature.offset, 0x40)))
        }
        return ecrecover(_hash, v, r, s);
    }
}
