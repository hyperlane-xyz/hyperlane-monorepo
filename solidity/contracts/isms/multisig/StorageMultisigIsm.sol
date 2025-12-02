// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractMultisigIsm} from "./AbstractMultisigIsm.sol";
import {AbstractMerkleRootMultisigIsm} from "./AbstractMerkleRootMultisigIsm.sol";
import {AbstractMessageIdMultisigIsm} from "./AbstractMessageIdMultisigIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IThresholdAddressFactory} from "../../interfaces/IThresholdAddressFactory.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

// ============ External Imports ============
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

abstract contract AbstractStorageMultisigIsm is
    AbstractMultisigIsm,
    Ownable2StepUpgradeable
{
    address[] public validators;
    uint8 public threshold;

    event ValidatorsAndThresholdSet(address[] validators, uint8 threshold);

    constructor(
        address[] memory _validators,
        uint8 _threshold
    ) Ownable2StepUpgradeable() {
        validators = _validators;
        threshold = _threshold;
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address[] memory _validators,
        uint8 _threshold
    ) external initializer {
        __Ownable2Step_init();
        setValidatorsAndThreshold(_validators, _threshold);
        _transferOwnership(_owner);
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

    constructor(
        address[] memory _validators,
        uint8 _threshold
    ) AbstractStorageMultisigIsm(_validators, _threshold) {}
}

contract StorageMessageIdMultisigIsm is
    AbstractMessageIdMultisigIsm,
    AbstractStorageMultisigIsm
{
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.MESSAGE_ID_MULTISIG);

    constructor(
        address[] memory _validators,
        uint8 _threshold
    ) AbstractStorageMultisigIsm(_validators, _threshold) {}
}

abstract contract StorageMultisigIsmFactory is
    IThresholdAddressFactory,
    PackageVersioned
{
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
        AbstractStorageMultisigIsm(ism).initialize(
            msg.sender,
            _validators,
            _threshold
        );
    }

    function implementation() public view virtual returns (address);
}

contract StorageMerkleRootMultisigIsmFactory is StorageMultisigIsmFactory {
    address internal immutable _implementation;

    constructor() {
        _implementation = address(
            new StorageMerkleRootMultisigIsm(new address[](0), 0)
        );
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}

contract StorageMessageIdMultisigIsmFactory is StorageMultisigIsmFactory {
    address internal immutable _implementation;

    constructor() {
        _implementation = address(
            new StorageMessageIdMultisigIsm(new address[](0), 0)
        );
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}
