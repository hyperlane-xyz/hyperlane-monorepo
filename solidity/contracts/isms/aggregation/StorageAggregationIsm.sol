// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractAggregationIsm} from "./AbstractAggregationIsm.sol";
import {IThresholdAddressFactory} from "../../interfaces/IThresholdAddressFactory.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

// ============ External Imports ============
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";

contract StorageAggregationIsm is
    AbstractAggregationIsm,
    Ownable2StepUpgradeable
{
    address[] public modules;
    uint8 public threshold;

    event ModulesAndThresholdSet(address[] modules, uint8 threshold);

    constructor(
        address[] memory _modules,
        uint8 _threshold
    ) Ownable2StepUpgradeable() {
        modules = _modules;
        threshold = _threshold;
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address[] memory _modules,
        uint8 _threshold
    ) external initializer {
        __Ownable2Step_init();
        setModulesAndThreshold(_modules, _threshold);
        _transferOwnership(_owner);
    }

    function setModulesAndThreshold(
        address[] memory _modules,
        uint8 _threshold
    ) public onlyOwner {
        require(
            0 < _threshold && _threshold <= _modules.length,
            "Invalid threshold"
        );
        modules = _modules;
        threshold = _threshold;
        emit ModulesAndThresholdSet(_modules, _threshold);
    }

    function modulesAndThreshold(
        bytes calldata /* _message */
    ) public view override returns (address[] memory, uint8) {
        return (modules, threshold);
    }
}

contract StorageAggregationIsmFactory is
    IThresholdAddressFactory,
    PackageVersioned
{
    address public immutable implementation;

    constructor() {
        implementation = address(
            new StorageAggregationIsm(new address[](1), 1)
        );
    }

    /**
     * @notice Emitted when a multisig module is deployed
     * @param module The deployed ISM
     */
    event ModuleDeployed(address module);

    // ============ External Functions ============
    function deploy(
        address[] calldata _modules,
        uint8 _threshold
    ) external returns (address ism) {
        ism = MinimalProxy.create(implementation);
        emit ModuleDeployed(ism);
        StorageAggregationIsm(ism).initialize(msg.sender, _modules, _threshold);
    }
}
