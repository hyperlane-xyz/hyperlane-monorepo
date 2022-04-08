// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IValidatorManager} from "../interfaces/IValidatorManager.sol";
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
    uint32 public immutable localDomain;

    // ============ Public Variables ============

    // Checkpoints of root => leaf index
    mapping(bytes32 => uint256) public checkpoints;
    // The latest checkpointed root
    bytes32 public checkpointedRoot;
    // Address of ValidatorManager contract.
    IValidatorManager public validatorManager;

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
     * @notice Emitted when the ValidatorManager contract is changed
     * @param validatorManager The address of the new validatorManager
     */
    event NewValidatorManager(address validatorManager);

    // ============ Modifiers ============

    // ============ Constructor ============

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
    }

    // ============ Initializer ============

    function __Common_initialize(address _validatorManager)
        internal
        initializer
    {
        // initialize owner
        __Ownable_init();
        _setValidatorManager(IValidatorManager(_validatorManager));
    }

    // ============ External Functions ============

    /**
     * @notice Set a new ValidatorManager contract
     * @dev Outbox(es) will initially be initialized using a trusted ValidatorManager contract;
     * we will progressively decentralize by swapping the trusted contract with a new implementation
     * that implements Validator bonding & slashing, and rules for Validator selection & rotation
     * @param _validatorManager the new ValidatorManager contract
     */
    function setValidatorManager(address _validatorManager) external onlyOwner {
        _setValidatorManager(IValidatorManager(_validatorManager));
    }

    /**
     * @notice Returns the latest checkpoint for the Validators to sign.
     * @return root Latest checkpointed root
     * @return index Latest checkpointed index
     */
    function latestCheckpoint()
        external
        view
        returns (bytes32 root, uint256 index)
    {
        root = checkpointedRoot;
        index = checkpoints[root];
    }

    // ============ Internal Functions ============

    /**
     * @notice Set the ValidatorManager
     * @param _validatorManager Address of the ValidatorManager
     */
    function _setValidatorManager(IValidatorManager _validatorManager)
        internal
    {
        require(
            Address.isContract(address(_validatorManager)),
            "!contract validatorManager"
        );
        validatorManager = _validatorManager;
        emit NewValidatorManager(address(_validatorManager));
    }

    /**
     * @notice Store the provided checkpoint.
     * @param _root The merkle root
     * @param _index The next available leaf index of the merkle tree.
     */
    function _checkpoint(bytes32 _root, uint256 _index) internal {
        checkpoints[_root] = _index;
        checkpointedRoot = _root;
        emit Checkpoint(_root, _index);
    }
}
