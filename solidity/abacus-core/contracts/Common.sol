// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {IValidatorManager} from "../interfaces/IValidatorManager.sol";
// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Common
 * @author Celo Labs Inc.
 * @notice Shared utilities between Home and Replica.
 */
abstract contract Common is OwnableUpgradeable {
    // ============ Immutable Variables ============

    // Domain of chain on which the contract is deployed
    uint32 public immutable localDomain;

    // ============ Public Variables ============

    // Address of ValidatorManager contract.
    IValidatorManager public validatorManager;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[49] private __GAP;

    // ============ Events ============

    /**
     * @notice Emitted when a root is checkpointed on Home or a signed
     * checkpoint is relayed to a Replica.
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
     * @dev Home(s) will initially be initialized using a trusted ValidatorManager contract;
     * we will progressively decentralize by swapping the trusted contract with a new implementation
     * that implements Validator bonding & slashing, and rules for Validator selection & rotation
     * @param _validatorManager the new ValidatorManager contract
     */
    function setValidatorManager(address _validatorManager) external onlyOwner {
        _setValidatorManager(IValidatorManager(_validatorManager));
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
        validatorManager = IValidatorManager(_validatorManager);
        emit NewValidatorManager(address(_validatorManager));
    }
}
