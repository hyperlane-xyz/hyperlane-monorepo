// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

// ============ External Imports ============
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IStaticWeightedMultisigIsm, IWeightedMultisigIsm} from "../../interfaces/isms/IWeightedMultisigIsm.sol";
import {Message} from "../../libs/Message.sol";

import {MerkleLib} from "../../libs/Merkle.sol";
import {AbstractMultisig} from "./AbstractMultisigIsm.sol";

abstract contract AbstractStaticWeightedMultisigIsm is
    AbstractMultisig,
    IStaticWeightedMultisigIsm
{
    // ============ Constants ============
    uint96 public constant BASIS_POINTS = 10000;

    function validatorsAndThresholdWeight(
        bytes calldata /* _message*/
    ) public view virtual returns (ValidatorInfo[] memory, uint96);

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) public view virtual returns (bool) {
        bytes32 _digest = digest(_metadata, _message);
        (
            ValidatorInfo[] memory _validators,
            uint96 _thresholdWeight
        ) = validatorsAndThresholdWeight(_message);
        require(
            _thresholdWeight > 0 && _thresholdWeight <= BASIS_POINTS,
            "Invalid threshold weight"
        );
        uint256 _validatorCount = _validators.length;
        uint256 _validatorIndex = 0;
        uint96 _totalWeight = 0;

        // Assumes that signatures are ordered by validator
        for (
            uint256 i = 0;
            _totalWeight < _thresholdWeight && i < _validatorCount;
            ++i
        ) {
            address _signer = ECDSA.recover(_digest, signatureAt(_metadata, i));
            // Loop through remaining validators until we find a match
            while (
                _validatorIndex < _validatorCount &&
                _signer != _validators[_validatorIndex].signingKey
            ) {
                ++_validatorIndex;
            }
            // Fail if we never found a match
            require(_validatorIndex < _validatorCount, "Invalid signer");

            // Add the weight of the current validator
            _totalWeight += _validators[_validatorIndex].weight;
        }
        require(
            _totalWeight >= _thresholdWeight,
            "Insufficient validator weight"
        );
        return true;
    }
}

/**
 * @title WeightedMultisigIsm
 * @notice Manages per-domain m-of-n Validator sets with stake weights that are used to verify
 * interchain messages.
 * @dev See ./AbstractMerkleRootWeightedIsm.sol and ./AbstractMessageIdWeightedIsm.sol
 * for concrete implementations of `digest` and `signatureAt`.
 * @dev See ./StaticWeightedIsm.sol for concrete implementations.
 */
abstract contract AbstractWeightedMultisigIsm is
    AbstractStaticWeightedMultisigIsm,
    IWeightedMultisigIsm,
    OwnableUpgradeable
{
    // ============ State Variables ============
    ValidatorInfo[] public validators;
    uint96 public thresholdWeight;

    // ============ Events ============
    event ValidatorSetUpdated(
        ValidatorInfo[] newValidators,
        uint96 newThresholdWeight
    );

    /**
     * @param _owner The owner of the contract.
     */
    function initialize(address _owner) public initializer {
        __Ownable_init();
        _transferOwnership(_owner);
    }

    function initialize(
        address _owner,
        ValidatorInfo[] calldata _validators,
        uint96 _thresholdWeight
    ) public initializer {
        __Ownable_init();
        _updateValidatorSet(_validators, _thresholdWeight);
        _transferOwnership(_owner);
    }

    /**
     * @notice Returns the set of validators responsible for verifying _message
     * and the number of signatures required
     * @dev Can change based on the content of _message
     * @dev Signatures provided to `verify` must be consistent with validator ordering
     * @return validators The array of validator addresses
     * @return threshold The number of validator signatures needed
     */
    function validatorsAndThresholdWeight(
        bytes calldata /* _message*/
    )
        public
        view
        virtual
        override(IStaticWeightedMultisigIsm, AbstractStaticWeightedMultisigIsm)
        returns (ValidatorInfo[] memory, uint96)
    {
        return (validators, thresholdWeight);
    }

    function updateValidatorSet(
        ValidatorInfo[] calldata _newValidators,
        uint96 _newThresholdWeight
    ) external onlyOwner {
        _updateValidatorSet(_newValidators, _newThresholdWeight);
    }

    function _updateValidatorSet(
        ValidatorInfo[] calldata _newValidators,
        uint96 _newThresholdWeight
    ) internal {
        require(_newValidators.length > 0, "Validator set cannot be empty");
        require(
            _newThresholdWeight > 0 && _newThresholdWeight <= BASIS_POINTS,
            "Invalid threshold weight"
        );

        uint96 totalWeight = 0;
        for (uint256 i = 0; i < _newValidators.length; i++) {
            require(
                _newValidators[i].signingKey != address(0),
                "Invalid validator address"
            );
            totalWeight += _newValidators[i].weight;
        }
        require(
            totalWeight == BASIS_POINTS,
            "Total weight must equal BASIS_POINTS"
        );

        delete validators;
        for (uint256 i = 0; i < _newValidators.length; i++) {
            validators.push(_newValidators[i]);
        }
        thresholdWeight = _newThresholdWeight;

        emit ValidatorSetUpdated(_newValidators, _newThresholdWeight);
    }
}
