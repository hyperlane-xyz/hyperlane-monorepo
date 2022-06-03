// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IMailbox} from "../interfaces/IMailbox.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

error SenderNotValidatorManager();
error AddressNotContract();
error CacheZeroCheckpointIndex();

/**
 * @title Mailbox
 * @author Celo Labs Inc.
 * @notice Shared utilities between Outbox and Inbox.
 */
abstract contract Mailbox is IMailbox, OwnableUpgradeable {
    // ============ Immutable Variables ============

    // Domain of chain on which the contract is deployed
    uint32 public immutable override localDomain;

    // ============ Public Variables ============

    // Cached checkpoints, mapping root => leaf index.
    // Cached checkpoints must have index > 0 as the presence of such
    // a checkpoint cannot be distinguished from its absence.
    mapping(bytes32 => uint256) public cachedCheckpoints;
    // The latest cached root
    bytes32 public latestCachedRoot;
    // Address of the validator manager contract.
    address public validatorManager;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a checkpoint is cached.
     * @param root Merkle root
     * @param index Leaf index
     */
    event CheckpointCached(bytes32 indexed root, uint256 indexed index);

    /**
     * @notice Emitted when the validator manager contract is changed
     * @param validatorManager The address of the new validatorManager
     */
    event NewValidatorManager(address validatorManager);

    // ============ Modifiers ============

    /**
     * @notice Ensures that a function is called by the validator manager contract.
     */
    modifier onlyValidatorManager() {
        if (msg.sender != validatorManager) {
            revert SenderNotValidatorManager();
        }
        _;
    }

    // ============ Constructor ============

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function __Mailbox_initialize(address _validatorManager)
        internal
        onlyInitializing
    {
        // initialize owner
        __Ownable_init();
        _setValidatorManager(_validatorManager);
    }

    // ============ External Functions ============

    /**
     * @notice Set a new validator manager contract
     * @dev Mailbox(es) will initially be initialized using a trusted validator manager contract;
     * we will progressively decentralize by swapping the trusted contract with a new implementation
     * that implements Validator bonding & slashing, and rules for Validator selection & rotation
     * @param _validatorManager the new validator manager contract
     */
    function setValidatorManager(address _validatorManager) external onlyOwner {
        _setValidatorManager(_validatorManager);
    }

    /**
     * @notice Returns the latest entry in the checkpoint cache.
     * @return root Latest cached root
     * @return index Latest cached index
     */
    function latestCachedCheckpoint()
        external
        view
        override
        returns (bytes32 root, uint256 index)
    {
        root = latestCachedRoot;
        index = cachedCheckpoints[root];
    }

    // ============ Internal Functions ============

    /**
     * @notice Set the validator manager
     * @param _validatorManager Address of the validator manager
     */
    function _setValidatorManager(address _validatorManager) internal {
        if (!Address.isContract(_validatorManager)) {
            revert AddressNotContract();
        }
        validatorManager = _validatorManager;
        emit NewValidatorManager(_validatorManager);
    }

    /**
     * @notice Caches the provided checkpoint.
     * Caching checkpoints with index == 0 are disallowed.
     * @param _root The merkle root to cache.
     * @param _index The leaf index of the latest message in the merkle tree.
     */
    function _cacheCheckpoint(bytes32 _root, uint256 _index) internal {
        if (_index == 0) {
            revert CacheZeroCheckpointIndex();
        }
        cachedCheckpoints[_root] = _index;
        latestCachedRoot = _root;
        emit CheckpointCached(_root, _index);
    }
}
