// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {ICommon} from "../interfaces/ICommon.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Common
 * @author Celo Labs Inc.
 * @notice Shared utilities between Outbox and Inbox.
 */
abstract contract Common is ICommon, OwnableUpgradeable {
    // ============ Immutable Variables ============

    // Domain of chain on which the contract is deployed
    uint32 public immutable override localDomain;

    // ============ Public Variables ============

    // Checkpoints of root => leaf index
    // Checkpoints of index 0 have to be disallowed as the existence of such
    // a checkpoint cannot be distinguished from their non-existence
    mapping(bytes32 => uint256) public checkpoints;
    // The latest checkpointed root
    bytes32 public checkpointedRoot;
    // Address of the validator manager contract.
    address public validatorManager;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a root is checkpointed on Outbox or a signed
     * checkpoint is relayed to a Inbox.
     * @param root Merkle root
     * @param index Leaf index
     */
    event Checkpoint(bytes32 indexed root, uint256 indexed index);

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
        require(msg.sender == validatorManager, "!validatorManager");
        _;
    }

    // ============ Constructor ============

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function __Common_initialize(address _validatorManager) internal onlyInitializing {
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
     * @notice Returns the latest checkpoint for the Validators to sign.
     * @return root Latest checkpointed root
     * @return index Latest checkpointed index
     */
    function latestCheckpoint()
        external
        view
        override
        returns (bytes32 root, uint256 index)
    {
        root = checkpointedRoot;
        index = checkpoints[root];
    }

    // ============ Internal Functions ============

    /**
     * @notice Set the validator manager
     * @param _validatorManager Address of the validator manager
     */
    function _setValidatorManager(address _validatorManager) internal {
        require(
            Address.isContract(_validatorManager),
            "!contract validatorManager"
        );
        validatorManager = _validatorManager;
        emit NewValidatorManager(_validatorManager);
    }

    /**
     * @notice Store the provided checkpoint.
     * @param _root The merkle root
     * @param _index The leaf index of the latest message in the merkle tree.
     */
    function _checkpoint(bytes32 _root, uint256 _index) internal {
        checkpoints[_root] = _index;
        checkpointedRoot = _root;
        emit Checkpoint(_root, _index);
    }
}
