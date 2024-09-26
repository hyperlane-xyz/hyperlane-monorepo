// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IThresholdAddressFactory} from "../../interfaces/IThresholdAddressFactory.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

abstract contract AbstractStorageMultisigIsm is
    AbstractMultisigIsm,
    OwnableUpgradeable
{
    address[] public validators;
    uint8 public threshold;

    event ValidatorsAndThresholdSet(address[] validators, uint8 threshold);

    constructor() OwnableUpgradeable() {
        _disableInitializers();
    }

    function initialize(
        address[] memory _validators,
        uint8 _threshold
    ) external initializer {
        __Ownable_init();
        setValidatorsAndThreshold(_validators, _threshold);
    }

    function setValidatorsAndThreshold(
        address[] memory _validators,
        uint8 _threshold
    ) public onlyOwner {
        require(
            0 < _threshold && _threshold <= _validators.length,
            "Invalid threshold"
        );
        validators = _validators;
        threshold = _threshold;
        emit ValidatorsAndThresholdSet(_validators, _threshold);
    }

    function validatorsAndThreshold(
        bytes calldata /* _message */
    ) public view override returns (address[] memory, uint8) {
        return (validators, threshold);
    }
}

contract StorageMerkleRootMultisigIsm is
    AbstractMerkleRootMultisigIsm,
    AbstractStorageMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MERKLE_ROOT_MULTISIG);
}

contract StorageMessageIdMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractStorageMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MERKLE_ROOT_MULTISIG);
}

abstract contract StorageMultisigIsmFactory is IThresholdAddressFactory {
    /**
     * @notice Emitted when a multisig module is deployed
     * @param module The deployed ISM
     */
    event ModuleDeployed(address module);

    // ============ External Functions ============
    function deploy(
        address[] calldata _validators,
        uint8 _threshold
    ) external returns (address ism) {
        ism = MinimalProxy.create(implementation());
        emit ModuleDeployed(ism);
        AbstractStorageMultisigIsm(ism).initialize(_validators, _threshold);
    }

    function implementation() public view virtual returns (address);
}

contract StorageMerkleRootMultisigIsmFactory is StorageMultisigIsmFactory {
    address internal immutable _implementation;

    constructor() {
        _implementation = address(new StorageMerkleRootMultisigIsm());
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}

contract StorageMessageIdMultisigIsmFactory is StorageMultisigIsmFactory {
    address internal immutable _implementation;

    constructor() {
        _implementation = address(new StorageMessageIdMultisigIsm());
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}
