// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ External Imports ============

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IStaticWeightedMultisigIsm} from "../interfaces/isms/IWeightedMultisigIsm.sol";

// ============ Internal Imports ============
import {MetaProxy} from "./MetaProxy.sol";
import {PackageVersioned} from "../PackageVersioned.sol";

abstract contract StaticWeightedValidatorSetFactory is PackageVersioned {
    // ============ Immutables ============
    address public immutable implementation;

    // ============ Constructor ============

    constructor() {
        implementation = _deployImplementation();
    }

    function _deployImplementation() internal virtual returns (address);

    /**
     * @notice Deploys a StaticWeightedValidatorSet contract address for the given
     * values
     * @dev Consider sorting addresses to ensure contract reuse
     * @param _validators An array of addresses
     * @param _thresholdWeight The threshold weight value to use
     * @return set The contract address representing this StaticWeightedValidatorSet
     */
    function deploy(
        IStaticWeightedMultisigIsm.ValidatorInfo[] calldata _validators,
        uint96 _thresholdWeight
    ) public returns (address) {
        (bytes32 _salt, bytes memory _bytecode) = _saltAndBytecode(
            _validators,
            _thresholdWeight
        );
        address _set = _getAddress(_salt, _bytecode);
        if (!Address.isContract(_set)) {
            _set = Create2.deploy(0, _salt, _bytecode);
        }
        return _set;
    }

    /**
     * @notice Returns the StaticWeightedValidatorSet contract address for the given
     * values
     * @dev Consider sorting addresses to ensure contract reuse
     * @param _validators An array of addresses
     * @param _thresholdWeight The threshold weight value to use
     * @return set The contract address representing this StaticWeightedValidatorSet
     */
    function getAddress(
        IStaticWeightedMultisigIsm.ValidatorInfo[] calldata _validators,
        uint96 _thresholdWeight
    ) external view returns (address) {
        (bytes32 _salt, bytes memory _bytecode) = _saltAndBytecode(
            _validators,
            _thresholdWeight
        );
        return _getAddress(_salt, _bytecode);
    }

    /**
     * @notice Returns the StaticWeightedValidatorSet contract address for the given
     * values
     * @param _salt The salt used in Create2
     * @param _bytecode The metaproxy bytecode used in Create2
     * @return set The contract address representing this StaticWeightedValidatorSet
     */
    function _getAddress(
        bytes32 _salt,
        bytes memory _bytecode
    ) internal view returns (address) {
        bytes32 _bytecodeHash = keccak256(_bytecode);
        return Create2.computeAddress(_salt, _bytecodeHash);
    }

    /**
     * @notice Returns the create2 salt and bytecode for the given values
     * @param _validators An array of addresses
     * @param _thresholdWeight The threshold weight value to use
     * @return _salt The salt used in Create2
     * @return _bytecode The metaproxy bytecode used in Create2
     */
    function _saltAndBytecode(
        IStaticWeightedMultisigIsm.ValidatorInfo[] calldata _validators,
        uint96 _thresholdWeight
    ) internal view returns (bytes32, bytes memory) {
        bytes memory _metadata = abi.encode(_validators, _thresholdWeight);
        bytes memory _bytecode = MetaProxy.bytecode(implementation, _metadata);
        bytes32 _salt = keccak256(_metadata);
        return (_salt, _bytecode);
    }
}
