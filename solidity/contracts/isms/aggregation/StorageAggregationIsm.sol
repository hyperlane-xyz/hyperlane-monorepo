// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {AbstractAggregationIsm} from "./AbstractAggregationIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IThresholdAddressFactory} from "../../interfaces/IThresholdAddressFactory.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract StorageAggregationIsm is AbstractAggregationIsm, OwnableUpgradeable {
    address[] public modules;
    uint8 public threshold;

    event ModulesAndThresholdSet(address[] modules, uint8 threshold);

    constructor(
        address[] memory _modules,
        uint8 _threshold
    ) OwnableUpgradeable() {
        modules = _modules;
        threshold = _threshold;
        _disableInitializers();
    }

    function initialize(
        address _owner,
        address[] memory _modules,
        uint8 _threshold
    ) external initializer {
        __Ownable_init();
        setModulesAndThreshold(_modules, _threshold);
        transferOwnership(_owner);
    }

    function setModulesAndThreshold(
        address[] memory _modules,
        uint8 _threshold
    ) public onlyOwner {
        require(_threshold <= _modules.length, "Invalid threshold");
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

contract StorageAggregationIsmFactory is IThresholdAddressFactory {
    address public immutable implementation;

    constructor() {
        implementation = address(
            new StorageAggregationIsm(new address[](0), 0)
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
