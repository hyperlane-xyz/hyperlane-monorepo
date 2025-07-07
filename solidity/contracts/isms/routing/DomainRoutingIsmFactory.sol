// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {MinimalProxy} from "../../libs/MinimalProxy.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";

abstract contract AbstractDomainRoutingIsmFactory is PackageVersioned {
    /**
     * @notice Emitted when a routing module is deployed
     * @param module The deployed ISM
     */
    event ModuleDeployed(DomainRoutingIsm module);

    // ============ External Functions ============

    /**
     * @notice Deploys and initializes a DomainRoutingIsm using a minimal proxy
     * @param _owner The owner to set on the ISM
     * @param _domains The origin domains
     * @param _modules The ISMs to use to verify messages
     */
    function deploy(
        address _owner,
        uint32[] calldata _domains,
        IInterchainSecurityModule[] calldata _modules
    ) external returns (DomainRoutingIsm) {
        DomainRoutingIsm.DomainModule[]
            memory domainModules = new DomainRoutingIsm.DomainModule[](
                _domains.length
            );
        require(_domains.length == _modules.length, "length mismatch");
        for (uint256 i = 0; i < _domains.length; ++i) {
            domainModules[i] = DomainRoutingIsm.DomainModule({
                domain: _domains[i],
                module: _modules[i]
            });
        }
        return deploy(_owner, domainModules);
    }

    /**
     * @notice Deploys and initializes a DomainRoutingIsm using a minimal proxy
     * @param _owner The owner to set on the ISM
     * @param _domainModules Array of DomainModule structs
     */
    function deploy(
        address _owner,
        DomainRoutingIsm.DomainModule[] memory _domainModules
    ) public returns (DomainRoutingIsm) {
        DomainRoutingIsm _ism = DomainRoutingIsm(
            MinimalProxy.create(implementation())
        );
        emit ModuleDeployed(_ism);
        _ism.initialize(_owner, _domainModules);
        return _ism;
    }

    function implementation() public view virtual returns (address);
}

/**
 * @title DomainRoutingIsmFactory
 */
contract DomainRoutingIsmFactory is AbstractDomainRoutingIsmFactory {
    // ============ Immutables ============
    address internal immutable _implementation;

    constructor() {
        _implementation = address(new DomainRoutingIsm());
    }

    function implementation() public view override returns (address) {
        return _implementation;
    }
}
