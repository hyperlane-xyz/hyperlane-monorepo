// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;
// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

// ============ Internal Imports ============
import {MetaProxy} from "./MetaProxy.sol";

abstract contract StaticThresholdAddressSetFactory {
    // ============ Immutables ============
    address public immutable implementation;

    // ============ Constructor ============

    constructor() {
        implementation = _deployImplementation();
    }

    function _deployImplementation() internal virtual returns (address);

    /**
     * @notice Deploys a StaticThresholdAddressSet contract address for the given
     * values
     * @dev Consider sorting addresses to ensure contract reuse
     * @param _values An array of addresses
     * @param _threshold The threshold value to use
     * @return set The contract address representing this StaticThresholdAddressSet
     */
    function deploy(
        address[] calldata _values,
        uint8 _threshold
    ) public returns (address) {
        (bytes32 _salt, bytes memory _bytecode) = _saltAndBytecode(
            _values,
            _threshold
        );
        address _set = _getAddress(_salt, _bytecode);
        if (!Address.isContract(_set)) {
            _set = Create2.deploy(0, _salt, _bytecode);
        }
        return _set;
    }

    /**
     * @notice Returns the StaticThresholdAddressSet contract address for the given
     * values
     * @dev Consider sorting addresses to ensure contract reuse
     * @param _values An array of addresses
     * @param _threshold The threshold value to use
     * @return set The contract address representing this StaticThresholdAddressSet
     */
    function getAddress(
        address[] calldata _values,
        uint8 _threshold
    ) external view returns (address) {
        (bytes32 _salt, bytes memory _bytecode) = _saltAndBytecode(
            _values,
            _threshold
        );
        return _getAddress(_salt, _bytecode);
    }

    /**
     * @notice Returns the StaticThresholdAddressSet contract address for the given
     * values
     * @param _salt The salt used in Create2
     * @param _bytecode The metaproxy bytecode used in Create2
     * @return set The contract address representing this StaticThresholdAddressSet
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
     * @param _values An array of addresses
     * @param _threshold The threshold value to use
     * @return _salt The salt used in Create2
     * @return _bytecode The metaproxy bytecode used in Create2
     */
    function _saltAndBytecode(
        address[] calldata _values,
        uint8 _threshold
    ) internal view returns (bytes32, bytes memory) {
        bytes memory _metadata = abi.encode(_values, _threshold);
        bytes memory _bytecode = MetaProxy.bytecode(implementation, _metadata);
        bytes32 _salt = keccak256(_metadata);
        return (_salt, _bytecode);
    }
}

abstract contract StaticAddressSetFactory is StaticThresholdAddressSetFactory {
    /**
     * @notice Deploys a StaticAddressSet contract address for the given
     * values
     * @dev Consider sorting addresses to ensure contract reuse
     * @param _values An array of addresses
     * @return set The contract address representing this StaticAddressSet
     */
    function deploy(address[] calldata _values) external returns (address) {
        return super.deploy(_values, uint8(_values.length));
    }

    /**
     * @notice Returns the StaticAddressSet contract address for the given
     * values
     * @dev Consider sorting addresses to ensure contract reuse
     * @param _values An array of addresses
     * @return set The contract address representing this StaticAddressSet
     */
    function getAddress(
        address[] calldata _values
    ) external view returns (address) {
        (bytes32 _salt, bytes memory _bytecode) = _saltAndBytecode(
            _values,
            uint8(_values.length)
        );
        return super._getAddress(_salt, _bytecode);
    }
}
